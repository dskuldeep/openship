/** Build → deploy execution engine. Extracted from build.service.ts — private pipeline: kickoffBuild fires executeBuildAndDeploy, which runs the build, deploy phases, and post-deploy sync. */

import { posix as pathPosix } from "node:path";
import { repos, type Project, type Deployment, type Domain } from "@repo/db";
import {
  BUILD_ENV_VARS,
  safeErrorMessage,
} from "@repo/core";
import type {
  BuildResult,
  CommandExecutor,
  DeployConfig,
  DeployEnvironment,
  LogEntry,
  ResourceConfig,
} from "@repo/adapters";
import {
  BareRuntime,
  BuildLogger,
  CloudRuntime,
  DEFAULT_BUILD_RESOURCE_CONFIG,
  ensurePortAvailable,
  runDeployPipeline,
  isMultiServiceRuntime,
} from "@repo/adapters";
import { platform } from "../../lib/controller-helpers";
import { internalApiUrl, runtimeTarget } from "../../config";
import { resolveDeploymentRuntime, resolveDeploymentPlatform } from "../../lib/deployment-runtime";
import { syncProjectToServerManifest } from "../../lib/openship-manifest-sync";
import { ensureManagedEdgeProxy } from "../../lib/managed-edge-proxy";
import { decryptEnvMap } from "../../lib/encryption";
import {
  buildProjectRouteDomains,
  createTrackedSslProvider,
  ensureRouteDomainRecord,
  toRoutedDomainInputs,
} from "../../lib/routing-domains";
import { normalizeTargetPath } from "../../lib/public-endpoints";
import { withDefaults } from "../../lib/resources";
import { resolveBuildGitToken } from "../github/clone-auth";
import { openDeployRelay } from "../../lib/git-forwarding";
import { resolveOrgOwner } from "../../lib/org-actor";
import {
  createCheckRun,
  updateCheckRun,
} from "../github/github.service";
import { firePreDeployBackups } from "../backups/triggers/pre-deploy";
import { buildBackgroundContext } from "../../lib/request-context";
import * as sessionManager from "./session-manager";
import { onFailure, onSuccess, onCancelled, setDeploymentStatus, type LifecycleContext } from "./deployment-lifecycle";
import { createBuildConfig } from "./build-config";
import {
  executeComposePipeline,
  resolveProjectServicePreflightServices,
  shouldUseProjectServicePipeline,
} from "./compose";
import { serviceKind, type DeployableService } from "../../lib/deployable-service";
import {
  resolveProjectRouteState,
} from "../domains/project-route.service";
import { type DeploymentConfigSnapshot } from "./build.service";
import * as settingsService from "../settings/settings.service";

// ─── Terminal output collapsing ──────────────────────────────────────────────

/**
 * Collapse raw log entries into their final terminal-rendered state.
 *
 * During live streaming, xterm handles \r (carriage return) to overwrite lines
 * in-place (e.g., git progress "Counting objects:  42%\r...100%").
 * When persisting to DB we don't want all intermediate lines - just the final
 * rendered result, as a terminal would show.
 *
 * Step events (entries with `step` field) pass through unchanged - they're
 * structured metadata for the stepper UI, not terminal output.
 */
function collapseTerminalLogs(entries: LogEntry[]): LogEntry[] {
  const result: LogEntry[] = [];
  // Virtual line buffer - simulates one terminal line
  let currentLine = "";
  let currentLevel: LogEntry["level"] = "info";
  let currentTimestamp = "";
  let currentServiceName: string | undefined;

  const flushLine = () => {
    const trimmed = currentLine.trimEnd();
    if (trimmed) {
      result.push({
        timestamp: currentTimestamp,
        message: trimmed,
        level: currentLevel,
        serviceName: currentServiceName,
      });
    }
    currentLine = "";
  };

  for (const entry of entries) {
    // Step events pass through as-is
    if (entry.step) {
      flushLine();
      result.push(entry);
      continue;
    }

    if (currentLine && entry.serviceName !== currentServiceName) {
      flushLine();
    }

    const text = entry.message;
    currentLevel = entry.level;
    currentTimestamp = entry.timestamp;
    currentServiceName = entry.serviceName;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\r") {
        // Check for \r\n (treat as plain newline)
        if (i + 1 < text.length && text[i + 1] === "\n") {
          flushLine();
          i++; // skip the \n
        } else {
          // Bare \r - overwrite: reset current line (don't flush)
          currentLine = "";
        }
      } else if (ch === "\n") {
        flushLine();
      } else {
        currentLine += ch;
      }
    }
  }

  // Flush any remaining content
  flushLine();
  return result;
}

function buildScopedEnvVars(
  envVars: Record<string, string>,
  opts?: { forceProductionNodeEnv?: boolean },
): {
  envVars: Record<string, string>;
  ignoredNodeEnv?: string;
} {
  const scoped = { ...envVars };
  let ignoredNodeEnv: string | undefined;

  if (opts?.forceProductionNodeEnv) {
    ignoredNodeEnv = scoped.NODE_ENV;
    delete scoped.NODE_ENV;
  }

  return {
    envVars: {
      ...BUILD_ENV_VARS,
      ...scoped,
      ...(opts?.forceProductionNodeEnv ? { NODE_ENV: "production" } : {}),
    },
    ignoredNodeEnv,
  };
}

function resolveStaticOutputDirectory(outputDirectory: string, targetPath?: string): string {
  const normalizedTargetPath = normalizeTargetPath(targetPath);
  if (!normalizedTargetPath || normalizedTargetPath === "/") {
    return outputDirectory;
  }

  if (!outputDirectory || outputDirectory === ".") {
    return normalizedTargetPath.slice(1);
  }

  return pathPosix.join(outputDirectory, normalizedTargetPath.slice(1));
}

/**
 * Compose-vs-normal pipeline gate (single source of truth).
 * Single mode short-circuits; otherwise we resolve services + pipeline in parallel.
 */
export async function resolveServicePipelineMode(
  project: Project,
  snapshot: DeploymentConfigSnapshot,
): Promise<{
  useSingleAppPipeline: boolean;
  useServicePipeline: boolean;
  servicePreflightServices: DeployableService[];
}> {
  if (snapshot.serviceDeploymentMode === "single") {
    return { useSingleAppPipeline: true, useServicePipeline: false, servicePreflightServices: [] };
  }

  const [servicePreflightServices, useServicePipeline] = await Promise.all([
    resolveProjectServicePreflightServices(project.id, snapshot.composeServices),
    shouldUseProjectServicePipeline(project, snapshot.composeServices),
  ]);

  return { useSingleAppPipeline: false, useServicePipeline, servicePreflightServices };
}

/**
 * Spawn the actual build pipeline for a freshly-queued deployment.
 *
 * Three callers (triggerDeployment, startBuild, redeployBuildSession) all
 * need to: locate the build session, register the SSE channel, then
 * fire-and-forget executeBuildAndDeploy with the safety-net error handler.
 * Extracted so changes (telemetry, throttling, queueing) happen in one
 * place instead of drifting across three.
 *
 * Returns the buildSessionId on success, or null when the build session
 * row is missing. The caller decides whether to throw or carry on - for
 * `redeploy` we want to skip silently; for `triggerDeployment` we throw.
 */
export async function kickoffBuild(project: Project, dep: Deployment): Promise<string | null> {
  const buildSession = await repos.deployment.findBuildSessionByDeploymentId(dep.id);
  if (!buildSession) return null;

  // Flip the row to "building" SYNCHRONOUSLY before firing the async
  // `executeBuildAndDeploy`. Without this, callers that chain
  // `redeployBuildSession` → `startBuild` (the dashboard does this on
  // every redeploy, see [build/[id]/page.tsx][1]) hit a race:
  //
  //   1. redeployBuildSession creates dep (status="queued") and calls
  //      kickoffBuild → fires executeBuildAndDeploy as `void`.
  //   2. kickoffBuild returns; the row is STILL "queued" because the
  //      async hasn't updated it yet.
  //   3. Dashboard reads the new deployment_id and calls /build/:id which
  //      runs startBuild → loadDeployment → status="queued" → falls through
  //      the idempotency guard at line ~1045 → kickoffBuild AGAIN.
  //   4. Two executeBuildAndDeploy in parallel for one deployment, both
  //      provisioning workspaces and double-logging to the same SSE
  //      stream - which is what users were seeing.
  //
  // [1]: apps/dashboard/src/app/(dashboard)/(deployment)/build/[id]/page.tsx
  await repos.deployment.updateStatus(dep.id, "building").catch(() => {
    // Best effort - if this fails, the worst case is the old race
    // returns. executeBuildAndDeploy will set the status itself when it
    // starts.
  });
  dep.status = "building";

  sessionManager.createSession(dep.id, project.id);

  void executeBuildAndDeploy(project, dep, buildSession.id).catch(async (err) => {
    console.error(`[DEPLOY] Fatal error for ${dep.id}:`, err);
    // executeBuildAndDeploy's inner try/catch only arms onFailure() after
    // snapshot + route state resolve. Anything that throws before that
    // (missing snapshot, route lookup crash, runtime resolution) would
    // otherwise leave the row queued forever - this guarantees the
    // deployment is marked failed and the SSE stream gets a closing
    // message.
    await markDeploymentFailedFromOutside(dep.id, err);
  });

  return buildSession.id;
}

/**
 * Fallback failure handler for errors thrown out of executeBuildAndDeploy
 * before its own try/catch arms onFailure(). Without this, an early
 * snapshot/route-state crash would leave the deployment stuck at "queued"
 * forever (the void .catch() just logged to console).
 *
 * Idempotent - if the deployment already reached "failed"/"ready"/"cancelled",
 * skips. Otherwise marks failed, flushes a final log line through SSE so the
 * dashboard stops spinning, and ends the session.
 */
async function markDeploymentFailedFromOutside(deploymentId: string, error: unknown): Promise<void> {
  const message = safeErrorMessage(error);
  try {
    const dep = await repos.deployment.findById(deploymentId).catch(() => null);
    if (!dep) return;
    if (["failed", "ready", "cancelled"].includes(dep.status)) {
      // Inner onFailure already ran (or the deploy somehow succeeded). Nothing to do.
      return;
    }
    await repos.deployment.updateStatus(deploymentId, "failed").catch(() => {});
    const buildSession = await repos.deployment.findBuildSessionByDeploymentId(deploymentId).catch(() => null);
    if (buildSession) {
      await repos.deployment.updateBuildSession(buildSession.id, {
        status: "failed",
        finishedAt: new Date(),
      }).catch(() => {});
    }
    // SSE: surface the error to anyone watching the stream and close it.
    sessionManager.appendLog(deploymentId, {
      timestamp: new Date().toISOString(),
      message: `Deployment failed before build started: ${message}`,
      level: "error",
    });
    sessionManager.updateStatus(deploymentId, "failed");
  } catch (handlerErr) {
    console.error(`[DEPLOY] markDeploymentFailedFromOutside crashed for ${deploymentId}:`, handlerErr);
  }
}

// ─── Smart per-service fan-out helpers ──────────────────────────────────────

/**
 * Pre-create `service_deployment` rows for SKIPPED services.
 *
 * For services in `targetServiceIds`, the compose pipeline creates
 * its own per-service rows during deploy (status patches reflect
 * build/deploy progress). For services NOT in the target list — i.e.
 * intentionally unchanged — the compose pipeline never runs, so this
 * helper inserts the `skipped` row up front. That keeps the fan-out
 * record on the deployment complete from the moment building starts.
 *
 * When `forceAll=true` or no target list is given, every enabled
 * service is considered targeted; we return without inserting.
 *
 * Returns ALL services (targeted + skipped) keyed by service id so
 * the caller can drive Checks API events.
 */
async function preCreateServiceDeployments(
  deploymentId: string,
  projectId: string,
  opts: {
    targetServiceIds?: string[];
    forceAll: boolean;
  },
): Promise<Map<string, { id: string | null; serviceId: string; serviceName: string; targeted: boolean }>> {
  const services = await repos.service.listByProject(projectId).catch(() => []);
  const enabled = services.filter((s) => s.enabled);
  const map = new Map<string, { id: string | null; serviceId: string; serviceName: string; targeted: boolean }>();
  if (enabled.length === 0) return map;

  const targetSet = opts.targetServiceIds && opts.targetServiceIds.length > 0
    ? new Set(opts.targetServiceIds)
    : null;

  // Compute (targeted? per service) up front so the caller can drive
  // per-service Checks events even before the compose pipeline runs.
  for (const svc of enabled) {
    const targeted = opts.forceAll || !targetSet || targetSet.has(svc.id);
    map.set(svc.id, {
      id: null,
      serviceId: svc.id,
      serviceName: svc.name,
      targeted,
    });
  }

  // Only insert SKIPPED rows here — targeted rows are created by the
  // downstream compose deploy path, which still owns its own writes.
  const skippedRows = enabled
    .filter((svc) => {
      const entry = map.get(svc.id);
      return entry ? !entry.targeted : false;
    })
    .map((svc) => ({
      deploymentId,
      serviceId: svc.id,
      serviceName: svc.name,
      status: "skipped" as const,
      reason: "unchanged",
      reasonSkipped: "unchanged",
    }));

  if (skippedRows.length > 0) {
    const inserted = await repos.serviceDeployment.bulkCreate(skippedRows);
    for (const row of inserted) {
      const existing = map.get(row.serviceId);
      if (existing) existing.id = row.id;
    }
  }

  return map;
}

/**
 * GitHub Checks API per-service hook.
 *
 * Best-effort: any failure is logged but never blocks the deploy. We
 * skip entirely when the project isn't backed by GitHub or when there
 * is no `commit_sha` (which would make `head_sha` invalid).
 */
async function emitServiceCheckRun(opts: {
  project: Project;
  dep: Deployment;
  serviceDeploymentId: string;
  serviceName: string;
  phase: "start" | "complete";
  conclusion?: "success" | "failure" | "cancelled" | "neutral";
  output?: { title: string; summary: string };
}): Promise<void> {
  const { project, dep, serviceDeploymentId, serviceName, phase, conclusion, output } = opts;
  if (!project.gitOwner || !project.gitRepo || !dep.commitSha) return;

  const orgMembers = await repos.member
    .listByOrganization(dep.organizationId)
    .catch(() => [] as Array<{ userId: string }>);
  const actorUserId = orgMembers[0]?.userId;
  if (!actorUserId) return;
  const actorCtx = buildBackgroundContext({
    userId: actorUserId,
    organizationId: dep.organizationId,
    label: "build:check-run",
  });

  if (phase === "start") {
    const result = await createCheckRun(actorCtx, project.gitOwner, project.gitRepo, {
      name: `build:${serviceName}`,
      headSha: dep.commitSha,
      status: "in_progress",
      detailsUrl: `${runtimeTarget.dashboard.replace(/\/$/, "")}/build/${dep.id}`,
    });
    if (result?.id) {
      await repos.serviceDeployment
        .update(serviceDeploymentId, {
          checkRunId: result.id,
          checkRunUrl: result.htmlUrl,
        })
        .catch(() => {});
    }
    return;
  }

  // phase === "complete"
  const sd = await repos.serviceDeployment.findById(serviceDeploymentId).catch(() => null);
  if (sd?.checkRunId) {
    await updateCheckRun(actorCtx, project.gitOwner, project.gitRepo, sd.checkRunId, {
      status: "completed",
      conclusion: conclusion ?? "neutral",
      output,
    });
  } else if (conclusion === "neutral") {
    // Skipped services were never started — create-and-complete in one
    // call so they still show up as a `neutral` check on the PR.
    const result = await createCheckRun(actorCtx, project.gitOwner, project.gitRepo, {
      name: `build:${serviceName}`,
      headSha: dep.commitSha,
      status: "completed",
      conclusion,
      detailsUrl: `${runtimeTarget.dashboard.replace(/\/$/, "")}/build/${dep.id}`,
      output: output ?? { title: "Skipped — no changes", summary: "Files under this service's root were unchanged." },
    });
    if (result?.id) {
      await repos.serviceDeployment
        .update(serviceDeploymentId, {
          checkRunId: result.id,
          checkRunUrl: result.htmlUrl,
        })
        .catch(() => {});
    }
  }
}

/**
 * Emit the initial per-service GitHub Checks for a fanned-out deploy:
 * targeted services get an `in_progress` "start" check, non-targeted ones
 * a neutral "skipped" check — so the PR check list is complete the moment
 * the deploy starts. Best-effort; the returned check_run_id is persisted
 * so the later `complete` emit patches the same Check.
 */
async function emitInitialServiceChecks(
  serviceFanOut: Awaited<ReturnType<typeof preCreateServiceDeployments>>,
  project: Project,
  dep: Deployment,
): Promise<void> {
  for (const entry of serviceFanOut.values()) {
    if (!entry.id) continue;
    if (entry.targeted) {
      await emitServiceCheckRun({
        project,
        dep,
        serviceDeploymentId: entry.id,
        serviceName: entry.serviceName,
        phase: "start",
      }).catch(() => {});
    } else {
      await emitServiceCheckRun({
        project,
        dep,
        serviceDeploymentId: entry.id,
        serviceName: entry.serviceName,
        phase: "complete",
        conclusion: "neutral",
        output: { title: "Skipped — no changes", summary: "Files under this service's root were unchanged." },
      }).catch(() => {});
    }
  }
}

/**
 * Roll up per-service results into the project-level deployment status.
 *
 *   - all `success` (or `skipped`)          → `ready`
 *   - mix of `success` and `failure`        → `partial_failure`
 *   - all `failure`                         → `failed`
 *
 * `skipped` rows are not counted as failures — they're intentional.
 */
function rollupDeploymentStatus(
  perService: Array<{ status: string }>,
): "ready" | "partial_failure" | "failed" {
  const real = perService.filter((s) => s.status !== "skipped");
  if (real.length === 0) return "ready";
  const successes = real.filter((s) => s.status === "success").length;
  const failures = real.filter((s) => s.status === "failure" || s.status === "cancelled").length;
  if (failures === 0) return "ready";
  if (successes === 0) return "failed";
  return "partial_failure";
}

/**
 * Hand the previous-active deployment to the rollback orchestrator: it
 * archives the prior artifact (so snapshot rollback stays possible), sets
 * artifact_retained_at on both rows, and prunes beyond the rollback
 * window. Git-strategy deploys SKIP this — rollback re-clones at
 * commit_sha_before, so there's no artifact to archive. Best-effort: the
 * new deployment is already live, so a failure here only affects rollback
 * eligibility, never the deploy outcome.
 */
async function archivePreviousDeployment(
  dep: Deployment,
  project: Project,
  logger: BuildLogger,
): Promise<void> {
  if (dep.rollbackStrategy === "git") {
    logger.log(
      "Skipping snapshot/artifact archive — rollback strategy is 'git' (rollback re-clones at commit_sha_before).",
    );
    return;
  }
  try {
    const { onDeploymentReady } = await import("./rollback");
    const finalDep = await repos.deployment.findById(dep.id);
    const prevDep = project.activeDeploymentId
      ? await repos.deployment.findById(project.activeDeploymentId)
      : null;
    if (finalDep) {
      await onDeploymentReady({ newDeployment: finalDep, previousActive: prevDep ?? null });
    }
  } catch (err) {
    logger.log(
      `Warning: failed to archive previous deployment for rollback: ${safeErrorMessage(err)}\n`,
      "warn",
    );
  }
}

/**
 * Finalize a compose (multi-service) deploy after executeComposePipeline:
 * roll the per-service results up into the project-level status (override
 * `ready` with `partial_failure` when some services failed), emit
 * per-service GitHub Checks, then archive the previous deployment.
 * Mirrors the single-app finalize tail in executeServerDeploy.
 */
async function finalizeComposeDeploy(opts: {
  project: Project;
  dep: Deployment;
  logger: BuildLogger;
}): Promise<void> {
  const { project, dep, logger } = opts;

  // Rollup + per-service Checks. Failures here must not roll back the deploy.
  try {
    const finalDep = await repos.deployment.findById(dep.id);
    if (finalDep && finalDep.status === "ready") {
      const perService = await repos.serviceDeployment.listByDeployment(dep.id);
      const rolled = rollupDeploymentStatus(perService);
      if (rolled === "partial_failure") {
        // partial_failure is a DB-only concept; SSE stays "ready" (the
        // dashboard reads partial_failure off the row) and surfaces the
        // partial as a live warning banner.
        await setDeploymentStatus(dep.id, "partial_failure", {
          sse: {
            status: "ready",
            meta: { warningMessage: "Some services failed — see service deployments for details." },
          },
        });
      } else if (rolled === "failed") {
        // Shouldn't happen — the compose pipeline marks ready only on
        // at-least-one success — but guard defensively.
        await setDeploymentStatus(dep.id, "failed");
      }

      // Per-service Checks API events.
      for (const sd of perService) {
        if (!sd.serviceName) continue;
        if (sd.status === "skipped") continue; // already emitted up front
        const conclusion =
          sd.status === "success" ? "success" : sd.status === "cancelled" ? "cancelled" : "failure";
        await emitServiceCheckRun({
          project,
          dep,
          serviceDeploymentId: sd.id,
          serviceName: sd.serviceName,
          phase: "complete",
          conclusion,
          output: {
            title: `${sd.serviceName} ${conclusion}`,
            summary: sd.errorMessage ?? sd.error ?? "",
          },
        }).catch(() => {});
      }
    }
  } catch (err) {
    // Rollup failures must not roll back the deploy.
    console.warn(`[build] rollup/Checks emission failed for ${dep.id}:`, err);
  }

  await archivePreviousDeployment(dep, project, logger);
}

// ─── Build & Deploy pipeline (private) ───────────────────────────────────────

async function executeBuildAndDeploy(project: Project, dep: Deployment, buildSessionId: string) {
  const plat = platform();
  let { runtime, routing, ssl, system } = plat;

  // ── Read config snapshot early so we can resolve the runtime ──────
  const snapshot = dep.meta as DeploymentConfigSnapshot | null;
  if (!snapshot) {
    throw new Error("Deployment has no config snapshot (meta is empty)");
  }
  const routeState = await resolveProjectRouteState(project);

  const logs: LogEntry[] = [];
  const MAX_LOG_ENTRIES = 50_000;

  const logCallback = (entry: LogEntry) => {
    if (logs.length < MAX_LOG_ENTRIES) logs.push(entry);
    sessionManager.appendLog(dep.id, entry);
  };

  // Single logger instance for the entire build→deploy lifecycle
  const logger = new BuildLogger(logCallback);

  /** Collapsed logs for DB persistence - resolves \r overwrites to final state. */
  const persistLogs = () => collapseTerminalLogs(logs);

  // ── Lifecycle context - shared across all phases ───────────────────
  const provisioned: { imageRef?: string } = {};
  const ctx: LifecycleContext = {
    runtime,
    project,
    dep,
    buildSessionId,
    persistLogs,
    provisioned,
  };

  try {
    // ── Resolve the full execution platform from deployment snapshot ──
    const resolved = await resolveDeploymentPlatform(snapshot, {
      organizationId: dep.organizationId,
      basePlatform: plat,
    });

    runtime = resolved.platform.runtime;
    routing = resolved.platform.routing;
    ssl = resolved.platform.ssl;
    system = resolved.platform.system;
    ctx.runtime = runtime;

    const usesManagedRouting = resolved.usesManagedRouting;
    const targetExecutor: CommandExecutor | null = resolved.platform.executor;

    // ── Build phase ──────────────────────────────────────────────────
    await repos.deployment.updateBuildSession(buildSessionId, {
      status: "building",
      startedAt: new Date(),
    });
    await setDeploymentStatus(dep.id, "building");

    // ── Smart per-service fan-out ────────────────────────────────────
    // Pre-create service_deployment rows so the dashboard sees a
    // complete fan-out even before any service starts building. Rows
    // for targeted services start as `pending`; everyone else is
    // marked `skipped` up front. The composeBuild pipeline patches
    // status as it goes; we roll up at the end.
    //
    // Done UP FRONT so a downstream crash still leaves a coherent
    // (deployment, services[]) shape behind.
    const serviceFanOut = await preCreateServiceDeployments(dep.id, project.id, {
      targetServiceIds: snapshot.targetServiceIds,
      forceAll: dep.forceAll ?? false,
    }).catch((err) => {
      // Best-effort: fan-out is a dashboard concern. A crash here must
      // not block the main build.
      console.warn(`[build] preCreateServiceDeployments crashed for ${dep.id}:`, err);
      return new Map<string, { id: string; serviceId: string; serviceName: string; targeted: boolean }>();
    });

    await emitInitialServiceChecks(serviceFanOut, project, dep);

    const prodResources = withDefaults(snapshot.resources);
    const buildResources = withDefaults(snapshot.buildResources, DEFAULT_BUILD_RESOURCE_CONFIG);

    // Decrypt env vars from deployment (self-contained). decryptEnvMap
    // drops keys that fail decryption rather than leaking ciphertext into
    // the build environment.
    const failedEnvKeys: string[] = [];
    const envMap = decryptEnvMap(
      (dep.envVars ?? {}) as Record<string, string>,
      (key: string, err: unknown) => {
        failedEnvKeys.push(key);
        console.warn(
          `[build] failed to decrypt env var ${key}: ${safeErrorMessage(err)}`,
        );
      },
    );
    // Surface dropped env in the BUILD LOG (not just the server console) so a
    // key-rotation data loss is visible to the operator instead of the build
    // silently running with missing env.
    if (failedEnvKeys.length > 0) {
      logger.log(
        `⚠ ${failedEnvKeys.length} environment variable(s) could not be decrypted and were skipped: ` +
          `${failedEnvKeys.join(", ")}. The encryption key likely changed since they were saved — ` +
          `re-enter them in the project's Environment settings and redeploy.`,
        "warn",
      );
    }
    // Single source of truth for buildStrategy, at the point of use. The deploy
    // entry points already resolve this onto the snapshot, but a legacy frozen
    // meta reused via rollback can arrive with it undefined — route through the
    // authority (idempotent for an already-resolved value) instead of a hardcoded
    // "server" fallback that would override the stack default ("local"). Resolved
    // here, ABOVE isLocalBuild, so every reader in this function sees one value.
    const buildStrategy = await settingsService.resolveStrategy(
      snapshot.framework,
      snapshot.buildStrategy,
      { deployTarget: snapshot.deployTarget },
    );
    const isLocalBuild = buildStrategy === "local";
    const buildEnv = buildScopedEnvVars(envMap, {
      forceProductionNodeEnv: isLocalBuild,
    });

    if (isLocalBuild && buildEnv.ignoredNodeEnv && buildEnv.ignoredNodeEnv !== "production") {
      logger.log(
        `Ignoring deployment NODE_ENV=${buildEnv.ignoredNodeEnv} during local build and forcing NODE_ENV=production.`,
        "warn",
      );
    }

    // Resolve a fresh GitHub token for cloning private repos.
    // Policy lives in resolveBuildGitToken - local builds keep the broad
    // resolver chain (token never leaves the API); remote builds in App
    // mode are installation-only; remote builds in non-App modes still
    // ship the user's token but the preflight check warns first.
    //
    // Org scoping: pass the project's organizationId so the App installation
    // lookup uses (organizationId, owner). The resolver falls back to the
    // per-user installation row when the org has none, but the org path is
    // the canonical one for multi-user deploys.
    // Automated/webhook builds have no human actor. Attribute the GitHub
    // token lookup to the org OWNER — the cloud-identity holder who owns
    // the App installation and is the only role with default GitHub
    // access (members need an explicit grant). A "first member" actor
    // would be DENIED by the github-access gate and break the build.
    const orgOwner = await resolveOrgOwner(dep.organizationId).catch(() => null);
    const actorUserId = orgOwner?.userId ?? "";

    // Resolved up front so the relay-fallback gate below can exclude
    // multi-service builds (whose clone path differs).
    const useServicePipeline = (await resolveServicePipelineMode(project, snapshot)).useServicePipeline;

    // Desktop git credential relay is eligible ONLY for a single-app build that
    // clones ON the remote host: effectiveTarget=server + the bare runtime
    // (runBuildPipeline clones via the executor) + server strategy. Docker
    // builds clone locally (token never leaves the orchestrator) and cloud
    // builds run in the workspace — neither needs/uses the relay.
    //
    // Point-of-use, off by default: the operator opts in PER DEPLOY (the deploy
    // flow's "Forward my git credentials" checkbox → snapshot.forwardGitCredentials).
    // Desktop-only is enforced here too (defense-in-depth — never honor a forged
    // flag on a non-desktop host; getLocalGhToken's CLOUD_MODE floor backs it up).
    let allowRelayFallback = false;
    if (
      plat.target === "desktop" &&
      snapshot.forwardGitCredentials === true &&
      resolved.effectiveTarget === "server" &&
      resolved.serverId &&
      runtime.name === "bare" &&
      buildStrategy === "server" &&
      !useServicePipeline
    ) {
      allowRelayFallback = true;
    }

    const gitCred = await resolveBuildGitToken({
      ctx: buildBackgroundContext({
        userId: actorUserId,
        organizationId: dep.organizationId,
        label: "build:resolve-git-token",
      }),
      projectId: project.id,
      owner: project.gitOwner ?? undefined,
      repo: project.gitRepo ?? undefined,
      buildStrategy,
      allowRelayFallback,
    });

    // Monorepo sub-app rows (kind="monorepo") fan out through the standard
    // compose pipeline below - each gets its own image, container, and
    // route. Per-app build/start commands live on the service row; no
    // project-row mirroring needed and no snapshot mutation here.

    const buildConfig = createBuildConfig({
      project,
      dep,
      snapshot,
      sessionId: buildSessionId,
      envVars: buildEnv.envVars,
      resources: buildResources,
      gitToken: gitCred.token,
    });

    if (useServicePipeline && isMultiServiceRuntime(runtime)) {
      // snapshot.composeServices is a DeployableService[] - mixed compose +
      // monorepo. syncFromCompose strictly owns compose rows; passing a
      // monorepo entry in causes a ghost compose-kind row to be inserted
      // alongside the real monorepo row (no DB unique constraint on
      // (projectId, name)). Filter to compose-kind before handing it off.
      const composeOnly = snapshot.composeServices?.filter(
        (s) => serviceKind(s) === "compose",
      );
      if (composeOnly?.length) {
        await repos.service.syncFromCompose(project.id, composeOnly);
      }

      await executeComposePipeline({
        project,
        dep,
        runtime,
        routing,
        ssl,
        usesManagedRouting,
        logger,
        ctx,
        snapshot,
        buildSessionId,
        buildEnvVars: buildEnv.envVars,
        buildResources,
        runtimeResources: prodResources,
        gitToken: gitCred.token,
      });

      // Roll per-service results up into the project status, emit
      // per-service Checks, and archive the previous deployment.
      await finalizeComposeDeploy({ project, dep, logger });
      return;
    }

    if (useServicePipeline) {
      const msg = `Project services are not supported on the "${runtime.name}" runtime yet. Use Docker runtime or deploy as a single app.`;
      logger.log(msg, "error");
      await onFailure(ctx, msg);
      return;
    }

    if (!snapshot.hasBuild) {
      logger.step(
        "build",
        "completed",
        "Build disabled - skipping install & build, using source directly",
      );
    }

    // Desktop git credential relay (fallback): the operator opted this server
    // into forwarding and there's no App/PAT token. Open the relay (reverse
    // tunnel + remote helper) right before the build so the clone fetches the
    // gh identity on demand — nothing persisted on the build host — and tear it
    // down in `finally` the moment the build (and its clone) finishes.
    let deployRelay: { scriptPath: string; close: () => Promise<void> } | null = null;
    if (gitCred.relay) {
      if (!targetExecutor || !resolved.serverId) {
        throw new Error(
          "Git credential forwarding is enabled, but no SSH executor is available for this server.",
        );
      }
      deployRelay = await openDeployRelay({
        serverId: resolved.serverId,
        executor: targetExecutor,
        sessionId: buildSessionId,
        // Repo-pin the relay to exactly this deploy's repo (when known) so it
        // never vends creds for any other repo. Absent owner/repo (e.g. a
        // local-path project) degrades to host-pin only.
        expectedOwner: project.gitOwner ?? undefined,
        expectedRepo: project.gitRepo ?? undefined,
      });
      if (!deployRelay) {
        throw new Error(
          "Git credential forwarding is enabled for this server, but its SSH auth method can't host the credential relay. Use key or password auth for this server, install the GitHub App, or add a per-project token.",
        );
      }
      buildConfig.gitCredentialHelperPath = deployRelay.scriptPath;
    }

    let buildResult: Awaited<ReturnType<typeof runtime.build>>;
    try {
      buildResult = await runtime.build(buildConfig, logger);
    } finally {
      // Reverse tunnel + remote helper script torn down regardless of outcome —
      // the credential is reachable only for the build's duration.
      if (deployRelay) await deployRelay.close().catch(() => {});
    }
    provisioned.imageRef = buildResult.imageRef;

    if (buildResult.status === "cancelled") {
      await onCancelled(ctx, buildResult.durationMs);
      return;
    }

    if (buildResult.status === "failed") {
      await onFailure(ctx, buildResult.errorMessage ?? "Build failed", buildResult.durationMs);
      return;
    }

    // Guard: build must produce an imageRef to proceed to deploy
    if (buildResult.status !== "deploying" || !buildResult.imageRef) {
      const msg = "Build completed but did not produce a deployable artifact";
      logger.step("build", "failed", msg);
      await onFailure(ctx, msg, buildResult.durationMs);
      return;
    }

    // ── Deploy phase ─────────────────────────────────────────────────
    await setDeploymentStatus(dep.id, "deploying", {
      extra: { imageRef: buildResult.imageRef, buildDurationMs: buildResult.durationMs },
    });

    const phase: DeployPhaseInputs = {
      ctx,
      project,
      dep,
      snapshot: snapshot,
      buildSessionId,
      runtime,
      routing,
      ssl,
      system,
      targetExecutor,
      baseTarget: plat.target,
      effectiveTarget: resolved.effectiveTarget,
      serverId: resolved.serverId,
      usesManagedRouting,
      routeState,
      buildResult,
      envMap,
      prodResources,
      logger,
    };

    if (!snapshot.hasServer && runtime instanceof CloudRuntime) {
      await executeStaticEdgeDeploy(phase, runtime);
    } else {
      await executeServerDeploy(phase);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.log(`Error: ${message}`, "error");
    await onFailure(ctx, message);
  }
}

// ─── Deploy phases ───────────────────────────────────────────────────────────

interface DeployPhaseInputs {
  ctx: LifecycleContext;
  project: Project;
  dep: Deployment;
  snapshot: DeploymentConfigSnapshot;
  buildSessionId: string;
  runtime: Awaited<ReturnType<typeof platform>>["runtime"];
  routing: Awaited<ReturnType<typeof platform>>["routing"];
  ssl: Awaited<ReturnType<typeof platform>>["ssl"];
  system: Awaited<ReturnType<typeof platform>>["system"];
  targetExecutor: CommandExecutor | null;
  /** Base platform target ("desktop" | "selfhosted" | "cloud") + the resolved
   *  per-deployment target/server — used to gate the `.openship` manifest write
   *  to desktop-mode server deploys only. */
  baseTarget: string;
  effectiveTarget: string;
  serverId: string | null;
  usesManagedRouting: boolean;
  routeState: Awaited<ReturnType<typeof resolveProjectRouteState>>;
  buildResult: BuildResult;
  envMap: Record<string, string>;
  prodResources: ResourceConfig;
  logger: BuildLogger;
}

/** Static edge deploy via CloudRuntime (Oblien Pages). */
async function executeStaticEdgeDeploy(
  phase: DeployPhaseInputs,
  runtime: CloudRuntime,
): Promise<void> {
  const { ctx, project, dep, snapshot, buildSessionId, routeState, buildResult, envMap, prodResources, logger } = phase;

  logger.step("deploy", "running", "Deploying to edge (static)...");

  const staticResult = await runtime.deployStatic({
    deploymentId: dep.id,
    projectId: project.id,
    buildSessionId,
    imageRef: buildResult.imageRef!,
    environment: dep.environment,
    port: snapshot.port,
    startCommand: snapshot.startCommand,
    stack: snapshot.framework,
    envVars: envMap,
    resources: prodResources,
    restartPolicy: "no",
    runtimeName: project.slug ?? project.id,
    publicEndpoints: routeState.publicEndpoints,
    outputDirectory: resolveStaticOutputDirectory(
      snapshot.outputDirectory,
      routeState.publicEndpoints[0]?.targetPath,
    ),
    projectName: project.name,
  });

  if (staticResult.status === "failed" || !staticResult.containerId) {
    logger.step("deploy", "failed", "Static deploy failed");
    await onFailure(ctx, "Failed to deploy static site to edge", buildResult.durationMs);
    return;
  }

  logger.step("deploy", "completed", "Deployed to edge successfully");

  await onSuccess(ctx, {
    containerId: staticResult.containerId,
    url: staticResult.url,
    durationMs: buildResult.durationMs ?? 0,
  });

  // Hand the previous-active deployment over to the rollback orchestrator —
  // same as the server-deploy path. Without this, edge/static deploys never
  // archive the prior deployment and snapshot rollback eligibility is silently
  // broken. Git-strategy deploys skip this since rollback re-clones at
  // commit_sha_before.
  if (dep.rollbackStrategy !== "git") {
    const { onDeploymentReady } = await import("./rollback");
    const finalDep = await repos.deployment.findById(dep.id);
    const prevDep = project.activeDeploymentId
      ? await repos.deployment.findById(project.activeDeploymentId)
      : null;
    if (finalDep) {
      await onDeploymentReady({
        newDeployment: finalDep,
        previousActive: prevDep ?? null,
      });
    }
  } else {
    logger.log(
      "Skipping snapshot/artifact archive — rollback strategy is 'git' (rollback re-clones at commit_sha_before).",
    );
  }
}

/**
 * Build the runtime DeployEnvironment (preflight + activate + deactivate +
 * route/url resolvers) for a server deploy. Static-self-hosted (bare,
 * file-backed) and containerized server deploys share one shape but differ
 * in a handful of closures — kept together here so executeServerDeploy
 * reads as a straight sequence.
 */
function buildDeployEnvironment(
  phase: DeployPhaseInputs,
  deps: {
    staticBareRuntime: BareRuntime | null;
    isStaticSelfHosted: boolean;
    previousRuntime: DeployPhaseInputs["runtime"];
    plannedDomains: ReturnType<typeof buildProjectRouteDomains>;
    canOverlap: boolean;
  },
): DeployEnvironment {
  const { runtime, system, targetExecutor, routeState, snapshot, logger } = phase;
  const { staticBareRuntime, isStaticSelfHosted, previousRuntime, plannedDomains, canOverlap } = deps;

  return {
    canOverlap,
    reactivatePrevious:
      previousRuntime.name === "bare"
        ? (id: string) => (id.includes("/") ? Promise.resolve() : previousRuntime.start(id))
        : undefined,
    preflight: targetExecutor
      ? async (cfg, promptUser) => {
          if (system) {
            const systemLog = (entry: { message: string; level: "info" | "warn" | "error" }) => {
              logger.log(`${entry.message}\n`, entry.level);
            };

            if (!isStaticSelfHosted) {
              await system.ensureFeature("deploy", systemLog);
            }
            if (plannedDomains.length > 0) {
              await system.ensureFeature("routing", systemLog);
            }
            if (plannedDomains.some((d) => d.provisionSsl)) {
              await system.ensureFeature("ssl", systemLog);
            }
          }

          if (!isStaticSelfHosted) {
            const ports = Array.from(
              new Set(
                (routeState.publicEndpoints.length > 0
                  ? routeState.publicEndpoints
                  : [{ port: cfg.port }])
                  .map((endpoint) => endpoint.port ?? cfg.port)
                  .filter((port): port is number => Number.isFinite(port)),
              ),
            );

            for (const port of ports) {
              await ensurePortAvailable(targetExecutor, port, logger, promptUser);
            }
          }
        }
      : undefined,
    activate: async (cfg, onLog) => {
      const r = isStaticSelfHosted
        ? await staticBareRuntime!.deployStatic({
            ...cfg,
            outputDirectory: cfg.outputDirectory ?? snapshot.outputDirectory,
          })
        : await runtime.deploy(cfg, onLog);
      if (!r.containerId) throw new Error("Deploy produced no container");
      return { containerId: r.containerId, url: r.url };
    },
    deactivate: (id) =>
      previousRuntime.name === "bare" && !id.includes("/")
        ? previousRuntime.stop(id)
        : previousRuntime.destroy(id),
    resolveRoute: isStaticSelfHosted
      ? async (id, cfg) => ({
          staticRoot: staticBareRuntime!.resolveStaticRoot(
            id,
            cfg.outputDirectory ?? snapshot.outputDirectory,
          ),
        })
      : undefined,
    resolveTargetUrl: runtime.supports("containerIp")
      ? async (id, port) => {
          const ip = await runtime.getContainerIp(id);
          return ip ? `http://${ip}:${port}` : null;
        }
      : undefined,
  };
}

/** Server deploy via runDeployPipeline (VM / Docker / Bare). Handles static-self-hosted too. */
async function executeServerDeploy(phase: DeployPhaseInputs): Promise<void> {
  const {
    ctx, project, dep, snapshot, buildSessionId,
    runtime, routing, ssl, usesManagedRouting,
    routeState, buildResult, envMap, prodResources, logger,
  } = phase;

  // Static sites are always served directly from the web server (OpenResty)
  // via file-backed routes - Docker is only for server apps.
  const staticBareRuntime =
    !snapshot.hasServer && runtime instanceof BareRuntime ? runtime : null;
  const isStaticSelfHosted = staticBareRuntime !== null;

  const deployConfig: DeployConfig = {
    deploymentId: dep.id,
    projectId: project.id,
    buildSessionId,
    imageRef: buildResult.imageRef!,
    environment: dep.environment,
    port: snapshot.port,
    startCommand: snapshot.startCommand,
    stack: snapshot.framework,
    envVars: envMap,
    resources: prodResources,
    restartPolicy: isStaticSelfHosted ? "no" : "always",
    runtimeName: project.slug ?? project.id,
    publicEndpoints: routeState.publicEndpoints,
    outputDirectory: snapshot.outputDirectory,
    productionPaths: snapshot.productionPaths.length ? snapshot.productionPaths : undefined,
    // Bare uses this to hard-link identical files across releases.
    // Other runtimes ignore it.
    previousDeploymentId: project.activeDeploymentId ?? undefined,
  };

  // Resolve the previous deployment + its runtime so we can deactivate it cleanly.
  const prevDep = project.activeDeploymentId
    ? await repos.deployment.findById(project.activeDeploymentId)
    : null;
  const previousRuntime = prevDep?.containerId
    ? await resolveDeploymentRuntime(prevDep)
        .then((r) => r.runtime)
        .catch(() => runtime)
    : runtime;

  // ── Plan + persist this deploy's routes ────────────────────────────
  // buildProjectRouteDomains turns the project's public endpoints (and
  // existing domain rows) into concrete routes. We persist a domain
  // record for each up front because SSL provisioning inside
  // runDeployPipeline writes cert status back onto these rows.
  const projectDomains = await repos.domain.listByProject(project.id);
  const domainByHostname = new Map(
    projectDomains.map((domain) => [domain.hostname.toLowerCase(), domain]),
  );
  const plannedDomains = buildProjectRouteDomains({
    project,
    projectDomains,
    managedSlug: routeState.publicEndpoints.length > 0 ? routeState.primarySlug : undefined,
    publicEndpoints: routeState.publicEndpoints,
    runtimeName: runtime.name,
    usesManagedRouting,
  });
  // Domains to prune after a successful deploy: project-level rows that
  // no longer back a current public endpoint AND aren't among the routes
  // we just planned. The size>0 guard is a safety valve — if endpoint
  // resolution yielded nothing (transient/empty), prune nothing rather
  // than nuke every route. The plannedHostnames check is belt-and-braces:
  // never prune a hostname this same deploy is registering.
  const activeRouteIds = new Set(
    routeState.publicEndpoints
      .map((endpoint) => endpoint.id)
      .filter((id): id is string => !!id),
  );
  const plannedHostnames = new Set(plannedDomains.map((domain) => domain.hostname.toLowerCase()));
  const obsoleteProjectDomains = activeRouteIds.size > 0
    ? projectDomains.filter(
        (domain) =>
          !domain.serviceId &&
          !activeRouteIds.has(domain.id) &&
          !plannedHostnames.has(domain.hostname.toLowerCase()),
      )
    : [];

  // Persist a domain record for each planned route. Track the ones we
  // CREATE here (vs pre-existing rows) so they can be rolled back if the
  // deploy fails — otherwise a failed deploy leaves orphan domain rows
  // that resurface as routes on the next deploy.
  const createdDomainIds: string[] = [];
  for (const route of plannedDomains) {
    const created = await ensureRouteDomainRecord({
      projectId: project.id,
      route,
      domainByHostname,
    });
    if (created && !projectDomains.some((d) => d.id === created.id)) {
      createdDomainIds.push(created.id);
      logger.log(`Created domain record for "${route.hostname}".\n`);
    }
  }

  // Overlap-capable = the new deployment can run alongside the old one (docker
  // unique-name + random host port; cloud isolated workspace). Bare binds a
  // fixed port and static is file-backed → stop-first. Drives the cutover order
  // AND the snapshot-artifact gate below.
  const canOverlap = !isStaticSelfHosted && runtime.name !== "bare";

  // Runtime deploy environment (preflight + activate + deactivate + resolvers).
  const deployEnv = buildDeployEnvironment(phase, {
    staticBareRuntime,
    isStaticSelfHosted,
    previousRuntime,
    plannedDomains,
    canOverlap,
  });

  const deploySsl = plannedDomains.some((domain) => domain.provisionSsl)
    ? createTrackedSslProvider(ssl, domainByHostname)
    : ssl;

  // Pre-deploy backups — fire BEFORE runDeployPipeline so the snapshot
  // captures the OLD container's state before runtime.destroy() in
  // compose/deploy.service.ts wipes it. Best-effort: we await only the
  // enqueue (so we know the run is durably queued before destruction),
  // not the run itself — a failing or slow backup must not block the
  // deploy. firePreDeployBackups returns { enqueued, failed } and
  // logs internally; we surface the count to the build log.
  try {
    const preBackup = await firePreDeployBackups({
      projectId: project.id,
      organizationId: dep.organizationId,
    });
    if (preBackup.enqueued > 0 || preBackup.failed > 0) {
      logger.log(
        `[pre-deploy-backup] enqueued=${preBackup.enqueued} failed=${preBackup.failed}`,
      );
    }
  } catch (err) {
    logger.log(
      `[pre-deploy-backup] trigger crashed (ignoring, best-effort): ${
        safeErrorMessage(err)
      }`,
    );
  }

  // Reap leftover containers from a previous MULTI-SERVICE / monorepo
  // deployment when this deploy collapses to single-app mode. runDeployPipeline
  // only deactivates prevDep.containerId — which in compose mode is just the
  // old primary service's container (or the literal "compose" sentinel, not a
  // real container) — so the remaining per-service containers
  // (openship-{slug}-{service}) have no owner in the single-app path and would
  // otherwise orphan. Skip the one runDeployPipeline already handles and the
  // sentinel. Best-effort; never blocks the deploy.
  if (prevDep) {
    const prevServiceDeps = await repos.service
      .listByDeployment(prevDep.id)
      .catch(() => []);
    for (const sd of prevServiceDeps) {
      if (!sd.containerId || sd.containerId === "compose" || sd.containerId === prevDep.containerId) {
        continue;
      }
      try {
        await previousRuntime.destroy(sd.containerId);
        logger.log(`Stopped leftover service container (${sd.containerId.slice(0, 12)}).\n`);
      } catch (err) {
        logger.log(
          `Warning: failed to stop leftover service container: ${safeErrorMessage(err)}\n`,
          "warn",
        );
      }
    }
  }

  // R1 gate: in overlap mode with SNAPSHOT strategy, let archivePreviousDeployment
  // stop+RETAIN the old artifact (for rollback) instead of the pipeline stopping
  // it — the old one keeps serving until the archive step (still zero-downtime).
  // git strategy skips archive, so the pipeline stops the old one itself; bare
  // (non-overlap) always stops first. previousContainerId stays accurate; the
  // flag only controls whether the pipeline deactivates.
  const deactivateOldInPipeline = !(canOverlap && dep.rollbackStrategy === "snapshot");

  const deployResult = await runDeployPipeline(
    deployEnv,
    {
      config: deployConfig,
      previousContainerId: prevDep?.containerId ?? undefined,
      deactivatePrevious: deactivateOldInPipeline,
      domains: toRoutedDomainInputs(plannedDomains),
      routing,
      ssl: deploySsl,
      routeOptions: project.webhookDomain
        ? {
            webhookDomain: project.webhookDomain,
            webhookProxy: `${internalApiUrl}/api/webhooks/`,
          }
        : undefined,
      promptUser: (prompt) => sessionManager.promptUser(dep.id, prompt),
    },
    logger,
  );

  if (deployResult.status === "failed") {
    // Reap the container this deploy STARTED if it failed during/after routing.
    // activeDeploymentId only advances on SUCCESS, so a started-but-failed
    // container is never any future deploy's prevDep and the 1-deep
    // prev-deactivation can never reach it — that's exactly how containers
    // piled up (3 for one project). Destroy it via the current runtime now.
    // Static deploys have no container. Best-effort + idempotent.
    if (deployResult.containerId && !isStaticSelfHosted) {
      await runtime.destroy(deployResult.containerId).catch((err) =>
        logger.log(
          `Warning: failed to clean up container after deploy failure: ${safeErrorMessage(err)}\n`,
          "warn",
        ),
      );
    }
    // Roll back the domain rows this deploy created — it didn't take, so
    // its routes must not linger (they'd resurface as planned routes next
    // deploy). Best-effort; pre-existing rows are left untouched.
    for (const id of createdDomainIds) {
      await repos.domain.remove(id).catch((err) =>
        logger.log(`Warning: failed to roll back domain record: ${safeErrorMessage(err)}\n`, "warn"),
      );
    }
    await onFailure(ctx, deployResult.error, buildResult.durationMs, {
      errorCode: deployResult.errorCode,
      errorDetails: deployResult.errorDetails,
    });
    return;
  }

  await runPostDeploySync({
    plannedDomains,
    obsoleteProjectDomains,
    routing,
    usesManagedRouting,
    organizationId: dep.organizationId,
    serverId: snapshot.serverId,
    // prevDep is intentionally NOT passed to runPostDeploySync anymore —
    // the RollbackOrchestrator below owns prev-artifact lifecycle now.
    // Keeping runPostDeploySync for managed-routing + obsolete-domain
    // cleanup only.
    logger,
  });

  await onSuccess(ctx, {
    containerId: deployResult.containerId!,
    url: deployResult.url,
    durationMs: buildResult.durationMs ?? 0,
  });

  // FINAL STEP (desktop-only, best-effort): mirror this project onto the
  // server's .openship/manifest.json so a fresh orchestrator can re-adopt it.
  // Self-gated inside — a no-op for VPS/self-hosted and non-server targets.
  await syncProjectToServerManifest({
    baseTarget: phase.baseTarget,
    effectiveTarget: phase.effectiveTarget,
    serverId: phase.serverId,
    executor: phase.targetExecutor,
    project,
    deployment: dep,
    containerId: deployResult.containerId!,
    log: (msg) => logger.log(`${msg}\n`),
  });

  await archivePreviousDeployment(dep, project, logger);
}

/** After a successful deploy: managed-edge sync + prune obsolete
 *  domains/routes. Previous-deployment artifact lifecycle has moved
 *  to the RollbackOrchestrator (rollback/rollback-orchestrator.ts). */
async function runPostDeploySync(opts: {
  plannedDomains: ReturnType<typeof buildProjectRouteDomains>;
  obsoleteProjectDomains: Domain[];
  routing: Awaited<ReturnType<typeof platform>>["routing"];
  usesManagedRouting: boolean;
  organizationId: string;
  serverId?: string;
  logger: BuildLogger;
}): Promise<void> {
  const {
    plannedDomains, obsoleteProjectDomains, routing, usesManagedRouting,
    organizationId, serverId, logger,
  } = opts;

  if (usesManagedRouting) {
    for (const domain of plannedDomains.filter((d) => d.isCloud && d.managedSubdomain)) {
      logger.log(`Syncing managed edge proxy for ${domain.hostname}...\n`);
      // Best-effort: this only wires the free .opsh.io URL through cloud
      // edge. Containers are up and custom domains route locally, so a
      // cloud failure (403, slug taken, unreachable) must not fail the deploy.
      try {
        await ensureManagedEdgeProxy(organizationId, domain.managedSubdomain!, { serverId });
      } catch (err) {
        logger.log(
          `Warning: could not sync managed edge proxy for ${domain.hostname}: ${safeErrorMessage(err)}. ` +
            `The deployment is live; this only affects the free ${domain.hostname} URL.\n`,
          "warn",
        );
      }
    }
  }

  for (const domain of obsoleteProjectDomains) {
    if (routing) {
      await routing.removeRoute(domain.hostname).catch((err) => {
        const message = safeErrorMessage(err);
        logger.log(`Warning: failed to remove stale route ${domain.hostname}: ${message}\n`, "warn");
      });
    }

    await repos.domain.remove(domain.id).catch((err) => {
      const message = safeErrorMessage(err);
      logger.log(`Warning: failed to remove stale domain record ${domain.hostname}: ${message}\n`, "warn");
    });
  }

  // Previous-image GC moved to the RollbackOrchestrator. It archives
  // the prev image (not destroys it) so rollback stays possible, and
  // prunes beyond rollbackWindow + skips pinned.
}
