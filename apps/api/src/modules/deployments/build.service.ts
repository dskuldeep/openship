/**
 * Build service — build session LIFECYCLE + config/snapshot helpers.
 *
 * Public API: triggerDeployment, requestBuildAccess, redeployBuildSession,
 * startBuild, cancelBuildSession, getBuildSessionStatus, respondToPrompt,
 * createQueuedDeployment, checkNoActiveBuild, buildConfigSnapshot,
 * runDeploymentPreflight, encryptEnvVars, metaWithPrevious.
 *
 * The build→deploy EXECUTION engine (kickoffBuild → executeBuildAndDeploy
 * → deploy phases → post-deploy sync) lives in `./build-pipeline.ts`.
 * Lifecycle entry points here call `kickoffBuild` from there; the split
 * keeps this file focused on session state + request validation. The
 * pipeline owns the deploy↔rollback cycle (a deliberate dynamic import).
 */

import { repos, type Project } from "@repo/db";
import {
  AppError,
  NotFoundError,
  ForbiddenError,
  SYSTEM,
  STACKS,
  getRuntimeImage,
  type StackId,
  type DeployTarget,
  type BuildStrategy,
  type StackDefinition,
} from "@repo/core";
import type {
  LogEntry,
  ResourceConfig,
} from "@repo/adapters";
import {
  resolveCloudResourceConfig,
  type CloudResourceTier,
  type CloudResourceCustom,
} from "./cloud-resources";
import { platform } from "../../lib/controller-helpers";
import { encrypt } from "../../lib/encryption";
import { getLatestCommit, getRepository } from "../github/github.service";
import { assertGitHubRepoAccess } from "../github/github-access";
import { resolveSmartRoute } from "./smart-route";
import { type RequestContext } from "../../lib/request-context";
import * as sessionManager from "./session-manager";
import {
  collectDeploymentManifest,
  executeCleanup,
  type CleanupManifest,
} from "../projects/project-cleanup.service";
import { runPreflightChecks, type PreflightResult } from "./preflight";
import {
  isMultiServiceProject,
  listProjectComposeServices,
  projectServicesToDeployableServices,
} from "./compose";
import * as settingsService from "../settings/settings.service";
import { type DeployableService } from "../../lib/deployable-service";
import {
  listProjectRouteRows,
  resolveProjectRouteState,
  syncProjectRouteState,
} from "../domains/project-route.service";
import { kickoffBuild, resolveServicePipelineMode } from "./build-pipeline";

function throwPreflightFailure(preflight: PreflightResult): never {
  const failedChecks = preflight.checks.filter((check) => check.status === "fail");
  const failures = failedChecks.map((check) => `${check.label}: ${check.message}`).join("; ");
  const codes = Array.from(
    new Set(
      failedChecks.map((check) => check.code).filter((code): code is string => Boolean(code)),
    ),
  );
  const errorCode =
    codes.length === 1 && failedChecks.every((check) => check.code === codes[0])
      ? codes[0]
      : "PRE_DEPLOY_CHECKS_FAILED";

  throw new AppError(`Pre-deploy checks failed: ${failures}`, 403, errorCode);
}

/** Wrap a snapshot with the project's currently-active deployment id (rollback target). */
export function metaWithPrevious(
  snapshot: DeploymentConfigSnapshot,
  project: Project,
): DeploymentConfigSnapshot {
  return { ...snapshot, previousActiveDeploymentId: project.activeDeploymentId ?? undefined };
}

/** Run preflight against a snapshot+route state and throw a structured failure on any check fail. */
export async function runDeploymentPreflight(
  snapshot: DeploymentConfigSnapshot,
  routeState: Awaited<ReturnType<typeof resolveProjectRouteState>>,
  opts: {
    ctx: RequestContext;
    composeServices?: DeployableService[];
    multiService?: boolean;
    /** Git owner of the source repo. Cloud preflight uses it to verify the
     *  GitHub App is installed for this owner before the build pipeline
     *  spends resources cloning a repo it can't access. */
    gitOwner?: string | null;
    /** Project id — passed to the remote-clone-token preflight check so
     *  project-scoped clone tokens are considered. */
    projectId?: string;
  },
): Promise<void> {
  const preflight = await runPreflightChecks(snapshot, {
    customDomain: routeState.primaryCustomDomain,
    slug:
      routeState.publicEndpoints.length > 0 && routeState.primaryDomainType === "free"
        ? routeState.primarySlug
        : undefined,
    ctx: opts.ctx,
    publicEndpoints: routeState.publicEndpoints,
    ...(opts.composeServices ? { composeServices: opts.composeServices } : {}),
    ...(opts.multiService !== undefined ? { multiService: opts.multiService } : {}),
    ...(opts.gitOwner !== undefined ? { gitOwner: opts.gitOwner } : {}),
    ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
    buildStrategy: snapshot.buildStrategy as "local" | "server" | undefined,
  });
  if (!preflight.ok) {
    throwPreflightFailure(preflight);
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

/** Config snapshot stored in deployment.meta - self-contained build+deploy config. */
export interface DeploymentConfigSnapshot {
  /** Owning organization — required so server lookups can be org-scoped. */
  organizationId?: string;
  repoUrl: string;
  branch: string;
  framework: string;
  buildImage: string;
  runtimeImage: string;
  packageManager: string;
  installCommand: string;
  buildCommand: string;
  outputDirectory: string;
  productionPaths: string[];
  rootDirectory: string;
  port: number;
  startCommand: string;
  resources: ResourceConfig | null;
  buildResources: ResourceConfig | null;
  /** Whether the project needs a running server (false = static, deploy via Pages) */
  hasServer: boolean;
  /** Whether the project needs a build step (false = deploy source directly) */
  hasBuild: boolean;
  /** Absolute path to a local project directory (alternative to repoUrl) */
  localPath?: string;
  /** Build strategy: "server" (build in workspace) or "local" (build on host) */
  buildStrategy?: BuildStrategy;
  /** Deploy target: "local" (this machine), "server" (remote SSH), or "cloud" (Oblien) */
  deployTarget?: DeployTarget;
  /** Target server ID when deployTarget is "server" */
  serverId?: string;
  /** Runtime mode: "bare" (direct process) or "docker" (container-based) */
  runtimeMode?: "bare" | "docker";
  /** Project services fan-out mode captured for this deployment. */
  serviceDeploymentMode?: "services" | "single";
  /**
   * Deployable services captured at deploy request time. Mixed shape:
   * compose-source rows AND monorepo sub-app rows travel through the
   * same pipeline, discriminated by `kind`. See `DeployableService`.
   */
  composeServices?: DeployableService[];
  /** Summary of a compose deployment fan-out, when applicable. */
  composeDeployment?: {
    totalServices: number;
    successfulServices: number;
    failedServices: number;
    failedServiceNames: string[];
    warningMessage?: string;
  };
  previousActiveDeploymentId?: string;
  /**
   * Smart per-service target list. When set, only these service ids
   * are (re)built; others are recorded as `service_deployment` rows
   * with `status='skipped'` so the fan-out has a complete record.
   */
  targetServiceIds?: string[];
  /**
   * Per-deploy opt-in to forward the operator's LOCAL `gh` identity to the
   * remote host for the on-server clone (desktop-only; default off). Drives the
   * HTTPS credential relay in the build pipeline — see `allowRelayFallback`.
   * Nothing is persisted on the remote; the relay closes when the build ends.
   */
  forwardGitCredentials?: boolean;
}

export interface BuildAccessInput {
  projectId: string;
  branch?: string;
  environment?: string;
  envVars?: Record<string, string>;
  publicEndpoints?: Array<{
    port?: string;
    targetPath?: string;
    domain?: string;
    customDomain?: string;
    domainType?: "free" | "custom";
  }>;
  buildStrategy?: BuildStrategy;
  deployTarget?: DeployTarget;
  serverId?: string;
  runtimeMode?: "bare" | "docker";
  serviceDeploymentMode?: "services" | "single";
  services?: DeployableService[];
  /** Openship Cloud resource tier picked in the UI (server-backed cloud deploys only). */
  cloudResourceTier?: CloudResourceTier;
  /** Custom CPU/RAM/disk, used only when cloudResourceTier === "custom". */
  cloudResourceCustom?: CloudResourceCustom;
  /**
   * Per-deploy opt-in to forward the operator's local `gh` identity to the
   * remote host for the on-server clone (desktop-only; default off). Carried
   * into the snapshot; the pipeline enforces desktop + server-build gating.
   */
  forwardGitCredentials?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a config snapshot from the project - pure pass-through, no fallbacks.
 *  All values must be set by prepare / ensureProject before this is called. */
export function buildConfigSnapshot(
  project: Project,
  branch?: string,
): DeploymentConfigSnapshot {
  const runtimeImage = resolveRuntimeImage(project);

  // why this needed while the snapshot already wired to project that has org id, doesnt all should have relatiopns
  return {
    // Owning org — needed by every downstream that does an org-scoped
    // lookup (preflight bridge, github installation resolver, runtime
    // factory). Multiple call sites used to set this AFTER snapshot
    // creation and the preflight call would race with `undefined` →
    // cloudClient({organizationId: undefined}) → null → outer code
    // shows "no cloud account connected". Set it here once, at the
    // source, where every snapshot consumer can rely on it.
    organizationId: project.organizationId,
    repoUrl: project.gitUrl ?? "",
    branch: branch || project.gitBranch || (project.localPath ? "main" : ""),
    framework: project.framework!,
    buildImage: project.buildImage!,
    runtimeImage,
    packageManager: project.packageManager!,
    installCommand: project.installCommand!,
    buildCommand: project.buildCommand!,
    outputDirectory: project.outputDirectory!,
    productionPaths: parseProductionPaths(project.productionPaths, project.framework),
    rootDirectory: project.rootDirectory || "",
    port: project.port ?? 3000,
    startCommand: project.startCommand!,
    resources: (project.resources as ResourceConfig) || null,
    buildResources: (project.buildResources as ResourceConfig) || null,
    hasServer: project.hasServer ?? !!project.startCommand?.trim(),
    hasBuild: project.hasBuild ?? true,
    localPath: project.localPath || undefined,
    // Per packages/db/src/schema/project.ts:231 — `cloudWorkspaceId IS
    // NOT NULL` is THE canonical "is this a cloud project?" test.
    // Default the snapshot's deployTarget from that so preflight,
    // pipeline, and rollback all see "cloud" without depending on the
    // UI to pass it on every redeploy. The desktop picker still wins
    // when it does pass an explicit deployTarget (see line ~773).
    deployTarget: project.cloudWorkspaceId ? "cloud" : undefined,
    // Runtime isolation mode persisted on the project (editable in the Runtime
    // tab). So a redeploy/webhook deploy respects the saved choice instead of
    // re-defaulting. The wizard's per-deploy override still wins when passed.
    runtimeMode: (project.runtimeMode as "bare" | "docker" | null) ?? undefined,
  };
}

async function resolveLatestCommitInfo(ctx: RequestContext, project: Project, branch: string) {
  if (!project.gitOwner || !project.gitRepo) {
    return {};
  }

  const head = await getLatestCommit(ctx, project.gitOwner, project.gitRepo, branch);
  return head ? { commitSha: head.sha, commitMessage: head.message } : {};
}

async function resolveProjectBranch(ctx: RequestContext, project: Project, branch?: string) {
  const configuredBranch = branch?.trim() || project.gitBranch?.trim();
  if (configuredBranch) return configuredBranch;

  if (project.gitOwner && project.gitRepo) {
    const repository = await getRepository(ctx, project.gitOwner, project.gitRepo);
    return repository.default_branch;
  }

  return "main";
}

/**
 * Single source of truth for a deployment's rollback context. Replaces the
 * blocks that were hand-copied (with divergent defaults) across
 * requestBuildAccess / triggerDeployment / redeployBuildSession / the webhook
 * push path.
 *
 *   - rollbackStrategy: explicit override wins, else the project default, else
 *     `"git"` (cheap re-clone at the prior commit; the unified default — set
 *     `project.defaultRollbackStrategy = "snapshot"` for instant artifact
 *     restore). createQueuedDeployment's backstop matches this same `"git"`.
 *   - commitShaBefore: explicit override wins, else the last successful deploy
 *     on this branch — the anchor a git-strategy rollback re-clones to.
 */
export async function resolveRollbackContext(
  project: Project,
  branch: string,
  override?: { rollbackStrategy?: "snapshot" | "git"; commitShaBefore?: string },
): Promise<{ rollbackStrategy: "snapshot" | "git"; commitShaBefore?: string }> {
  const rollbackStrategy =
    override?.rollbackStrategy ??
    (project.defaultRollbackStrategy as "snapshot" | "git" | undefined) ??
    "git";

  let commitShaBefore = override?.commitShaBefore;
  if (!commitShaBefore) {
    const lastGood = await repos.deployment
      .getLatestSuccessfulForBranch(project.id, branch)
      .catch(() => null);
    commitShaBefore = lastGood?.commitSha ?? undefined;
  }

  return { rollbackStrategy, commitShaBefore };
}

/**
 * Single source of truth for a deployment snapshot's TARGET — deployTarget +
 * serverId + runtimeMode. Used by BOTH deploy entry points (requestBuildAccess
 * and triggerDeployment) so they can never diverge on where a project deploys.
 *
 * Precedence:
 *   - deployTarget: explicit per-deploy override (the wizard picker)
 *       > cloudWorkspaceId (the canonical "is a cloud project" primitive)
 *       > the project's ACTIVE deployment's last target (what it runs on now)
 *       > undefined (host default, resolved later by the pipeline's resolver).
 *   - serverId: ONLY kept when the resolved target is "server". For cloud/local
 *       it is dropped, so a non-server deploy can't carry a stale serverId and
 *       mis-route (the bug the unconditional inheritance had).
 *   - runtimeMode: override > project.runtimeMode column > active-meta.
 */
export async function resolveSnapshotTarget(
  project: Project,
  override?: { deployTarget?: DeployTarget; serverId?: string; runtimeMode?: "bare" | "docker" },
): Promise<{ deployTarget?: DeployTarget; serverId?: string; runtimeMode?: "bare" | "docker" }> {
  const activeMeta = project.activeDeploymentId
    ? ((await repos.deployment.findById(project.activeDeploymentId).catch(() => null))
        ?.meta as DeploymentConfigSnapshot | null)
    : null;

  const deployTarget: DeployTarget | undefined =
    override?.deployTarget ??
    (project.cloudWorkspaceId ? "cloud" : (activeMeta?.deployTarget ?? undefined)) ??
    undefined;

  const serverId =
    deployTarget === "server"
      ? (override?.serverId ?? activeMeta?.serverId ?? undefined)
      : undefined;

  const runtimeMode =
    override?.runtimeMode ??
    ((project.runtimeMode as "bare" | "docker" | null) ?? undefined) ??
    (activeMeta?.runtimeMode ?? undefined);

  return { deployTarget, serverId, runtimeMode };
}

function resolveRuntimeImage(project: Project): string {
  const hasServer = project.hasServer ?? !!project.startCommand?.trim();
  const stackId = (
    project.framework && project.framework in STACKS ? project.framework : "unknown"
  ) as StackId;

  if (!hasServer) {
    return getRuntimeImage("static", project.packageManager ?? undefined);
  }

  return getRuntimeImage(stackId, project.packageManager ?? undefined);
}

/** Parse productionPaths from DB text (comma-separated) with STACKS fallback. */
function parseProductionPaths(
  raw: string | null | undefined,
  framework: string | null | undefined,
): string[] {
  if (raw)
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  if (framework && framework in STACKS) {
    const paths = STACKS[framework as StackId] as StackDefinition;
    return paths.productionPaths ? [...paths.productionPaths] : [];
  }
  return [];
}

/** Encrypt a plaintext key-value map. Returns null if empty. */
export function encryptEnvVars(envVars?: Record<string, string>): Record<string, string> | null {
  if (!envVars || Object.keys(envVars).length === 0) return null;
  const encrypted: Record<string, string> = {};
  for (const [k, v] of Object.entries(envVars)) {
    encrypted[k] = encrypt(v);
  }
  return encrypted;
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Load a deployment + its project, refusing if their organizations don't
 * agree. The calling route's permission middleware already verified the
 * caller is a member of the deployment's org; this is a defense-in-depth
 * check against a deployment ever outliving a project moving orgs.
 */
async function loadDeployment(deploymentId: string) {
  const dep = await repos.deployment.findById(deploymentId);
  if (!dep) throw new NotFoundError("Deployment", deploymentId);

  const project = await repos.project.findById(dep.projectId);
  if (!project) throw new NotFoundError("Deployment", deploymentId);

  if (dep.organizationId !== project.organizationId) {
    throw new NotFoundError("Deployment", deploymentId);
  }

  return { dep, project };
}

/** Throw if the project already has an in-progress deployment. */
export async function checkNoActiveBuild(projectId: string) {
  const { rows } = await repos.deployment.listByProject(projectId, {
    page: 1,
    perPage: SYSTEM.DEPLOYMENTS.MAX_CONCURRENT_PER_PROJECT + 1,
  });
  const active = rows.find((d) => ["queued", "building", "deploying"].includes(d.status));
  if (active) {
    throw new ForbiddenError(
      `A deployment is already in progress (${active.id}). Cancel it first or wait for it to complete.`,
    );
  }
}

/**
 * Create a queued deployment + build session atomically.
 * If the build session insert fails, the deployment is cleaned up.
 */
/**
 * Detection: the partial unique index uq_deployment_one_active_per_project
 * surfaces this Postgres / pglite error code when two webhook
 * deliveries race to create a deployment for the same project.
 */
function isActiveDeploymentRace(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | undefined;
  if (!e) return false;
  if (e.code === "23505") return true; // unique_violation
  return Boolean(e.message?.includes("uq_deployment_one_active_per_project"));
}

export async function createQueuedDeployment(opts: {
  projectId: string;
  /** Org that owns this deployment. Pass project.organizationId — the
   *  scoping key for the row. (Actor attribution lives on the audit
   *  layer, not on the deployment row.) */
  organizationId: string;
  branch: string;
  environment: string;
  framework: string;
  meta: DeploymentConfigSnapshot;
  envVars: Record<string, string> | null;
  commitSha?: string;
  commitMessage?: string;
  trigger?: string;
  /** Rollback policy for THIS deployment. Defaults to 'git' (matches
   *  resolveRollbackContext + the project default). */
  rollbackStrategy?: "snapshot" | "git";
  /** SHA active before this deploy — used by git-strategy rollback. */
  commitShaBefore?: string;
  /** Force-rebuild every service regardless of changed paths. */
  forceAll?: boolean;
  /** Smart per-service targeting — passed through to the executor via meta. */
  serviceIds?: string[];
  /** Changed-file paths traced for this version (file/root tracing). */
  changedPaths?: string[] | null;
  changedPathsTruncated?: boolean;
}) {
  // Persist the smart-deploy serviceIds onto the snapshot so the
  // executor can find them without re-resolving from request scope.
  const meta: DeploymentConfigSnapshot = opts.serviceIds && opts.serviceIds.length > 0
    ? { ...opts.meta, targetServiceIds: opts.serviceIds }
    : opts.meta;

  // Monotonic per-project version (v1, v2, …). The one-in-flight-per-project
  // unique index below serializes concurrent creates, so MAX+1 can't collide.
  const version = await repos.deployment.getNextVersion(opts.projectId);

  let dep;
  try {
    dep = await repos.deployment.create({
      projectId: opts.projectId,
      organizationId: opts.organizationId,
      branch: opts.branch,
      commitSha: opts.commitSha,
      commitMessage: opts.commitMessage,
      trigger: opts.trigger ?? "manual",
      environment: opts.environment,
      framework: opts.framework,
      status: "queued",
      version,
      meta,
      envVars: opts.envVars,
      // Default to git: most projects are GitHub-backed and re-cloning
      // at the previous commit_sha is cheaper than archiving artifacts.
      // Callers that need snapshot pass it explicitly (or set the
      // per-project default via project.defaultRollbackStrategy).
      rollbackStrategy: opts.rollbackStrategy ?? "git",
      commitShaBefore: opts.commitShaBefore,
      forceAll: opts.forceAll ?? false,
      changedPaths: opts.changedPaths ?? null,
      changedPathsTruncated: opts.changedPathsTruncated ?? false,
    });
  } catch (err) {
    // Race: another caller raced past checkNoActiveBuild and won the
    // INSERT. Surface as a 403 to match the early-rejection path.
    if (isActiveDeploymentRace(err)) {
      throw new ForbiddenError(
        "Another deployment is already in progress for this project. Wait for it to finish or cancel it.",
      );
    }
    throw err;
  }

  try {
    await repos.deployment.createBuildSession({
      deploymentId: dep.id,
      projectId: opts.projectId,
      status: "queued",
    });
  } catch (err) {
    // Atomicity: clean up orphaned deployment
    await repos.deployment.deleteDeployment(dep.id).catch(() => {});
    throw err;
  }

  return dep;
}

// ─── SSE streaming (re-export) ───────────────────────────────────────────────

/** Subscribe to live build logs by deployment ID (dep_xxx). */
export { subscribe as subscribeToBuildSession } from "./session-manager";

// ─── Build access (create deployment with config snapshot) ───────────────────

/**
 * Create a deployment + build session for an existing project.
 * Snapshots project config into deployment.meta,
 * encrypts env vars into deployment.envVars.
 *
 * Project MUST exist before calling this.
 */

/** Resolve a pending pipeline prompt (e.g. port conflict). */
export async function respondToPrompt(
  deploymentId: string,
  action: string,
): Promise<boolean> {
  await loadDeployment(deploymentId);
  return sessionManager.respondToPrompt(deploymentId, action);
}

export async function requestBuildAccess(ctx: RequestContext, input: BuildAccessInput) {
  const {
    projectId,
    branch,
    environment,
    envVars,
    publicEndpoints,
    buildStrategy,
    deployTarget,
    serverId,
    runtimeMode,
    serviceDeploymentMode,
    services,
    cloudResourceTier,
    cloudResourceCustom,
    forwardGitCredentials,
  } = input;

  const project = await repos.project.findById(projectId);
  if (!project) {
    throw new NotFoundError("Project", projectId);
  }
  // Org-membership is verified by the route-level requirePermission
  // middleware before this is reached.
  // GitHub access gate: default-deny for everyone but the org owner —
  // a member can deploy a GitHub-backed project only when granted this
  // repo. Hard-stop here so they can't fall through to their personal
  // token on a local build (owner-control bypass) or fail mid-build.
  await assertGitHubRepoAccess(ctx, {
    owner: project.gitOwner,
    repo: project.gitRepo,
  });

  await checkNoActiveBuild(project.id);

  const resolvedBranch = await resolveProjectBranch(ctx, project, branch);
  const projectDomains = await listProjectRouteRows(project.id);
  let routeState = await resolveProjectRouteState(project, { projectDomains });
  const snapshot = buildConfigSnapshot(project, resolvedBranch);

  if (publicEndpoints !== undefined) {
    const routing = await syncProjectRouteState(project, {
      projectDomains,
      nextPublicEndpoints: publicEndpoints,
      slug: routeState.publicEndpoints.find((endpoint) => endpoint.domainType === "free")?.domain,
    });
    routeState = routing;
  }

  const requestedServiceMode =
    serviceDeploymentMode === "single"
      ? "single"
      : serviceDeploymentMode === "services" || services?.length
        ? "services"
        : undefined;

  if (requestedServiceMode) {
    snapshot.serviceDeploymentMode = requestedServiceMode;
  }
  if (requestedServiceMode === "services" && services?.length) {
    snapshot.composeServices = services;
  }
  const { useServicePipeline, servicePreflightServices } = await resolveServicePipelineMode(
    project,
    snapshot,
  );

  // Resolve the snapshot's target (deployTarget + serverId + runtimeMode) from
  // the single source of truth shared with triggerDeployment — UI override >
  // cloudWorkspaceId > active-deployment meta. Keeps the two deploy entry points
  // from diverging on where a project deploys.
  const resolvedTarget = await resolveSnapshotTarget(project, { deployTarget, serverId, runtimeMode });
  snapshot.deployTarget = resolvedTarget.deployTarget;
  snapshot.serverId = resolvedTarget.serverId;
  snapshot.runtimeMode = resolvedTarget.runtimeMode;

  // Resolve effective build strategy via settings service.
  // Pass deployTarget so that — absent an explicit per-deploy choice — the
  // cloud target defaults to a cloud-side build (right toolchain, no host
  // resource burn). See settingsService.resolveStrategy priority chain.
  snapshot.buildStrategy = await settingsService.resolveStrategy(
    snapshot.framework,
    buildStrategy ?? snapshot.buildStrategy,
    { deployTarget: snapshot.deployTarget },
  );
  // Per-deploy git credential forwarding choice (desktop-only; default off).
  // We carry the raw choice; the build pipeline enforces desktop + server-build
  // gating before opening the relay, so a forged flag elsewhere is inert.
  if (forwardGitCredentials === true) {
    snapshot.forwardGitCredentials = true;
  }

  // Openship Cloud resource tier — only a SERVER-BACKED cloud (Oblien)
  // deploy provisions a workspace sized by these resources. Static (Pages)
  // deploys have no workspace to size, and non-cloud targets keep the
  // project's own resource config, so the picker is ignored for them.
  // The resolved ResourceConfig rides the existing `snapshot.resources`
  // plumbing → prodResources → runtime.deploy / ensureServiceGroup →
  // cloud.ts (cpus/memory_mb/disk_size_mb).
  if (snapshot.deployTarget === "cloud" && snapshot.hasServer && cloudResourceTier) {
    snapshot.resources = resolveCloudResourceConfig(cloudResourceTier, cloudResourceCustom);
  }

  // ── Preflight: validate config + domain before creating any resources ──
  await runDeploymentPreflight(snapshot, routeState, {
    ctx,
    composeServices: servicePreflightServices,
    multiService: useServicePipeline,
    gitOwner: project.gitOwner,
    projectId: project.id,
  });
  const env = environment || "production";

  // ── Resolve commit info from the branch HEAD ────
  const { commitSha, commitMessage } = await resolveLatestCommitInfo(
    ctx,
    project,
    snapshot.branch,
  );

  // ── Resolve rollback context (shared helper — single default) ─────────
  const { rollbackStrategy, commitShaBefore } = await resolveRollbackContext(
    project,
    snapshot.branch,
  );

  const dep = await createQueuedDeployment({
    projectId: project.id,
    organizationId: project.organizationId ?? null,
    branch: snapshot.branch,
    commitSha,
    commitMessage,
    environment: env,
    framework: snapshot.framework,
    meta: metaWithPrevious(snapshot, project),
    envVars: encryptEnvVars(envVars),
    rollbackStrategy,
    commitShaBefore,
  });

  // Store env vars on project as "latest defaults"
  if (envVars && Object.keys(envVars).length > 0) {
    const vars = Object.entries(envVars).map(([key, value]) => ({
      key,
      value: encrypt(value),
      isSecret: false,
    }));
    await repos.project.bulkSetEnvVars(project.id, env, vars);
  }

  // Kick off the build BEFORE returning so the dashboard can attach via the
  // safe GET /:id/stream path (startBuild=false) instead of the racy POST
  // /:id/build round-trip. Without this, the dashboard had to make a second
  // call that both starts the build AND opens SSE — when that call stalled
  // (common during cloud-workspace provisioning), the SSE reconnect gate
  // refused to retry and the user saw an empty terminal until refresh.
  //
  // Mirrors `redeployBuildSession`'s kickoff — same race, same fix. startBuild
  // is idempotent (see its guard) so a stale follow-up POST is a no-op.
  await kickoffBuild(project, dep);

  return {
    success: true,
    deployment_id: dep.id,
    project_id: project.id,
  };
}

// ─── Build session status ────────────────────────────────────────────────────

export async function getBuildSessionStatus(deploymentId: string) {
  const { dep, project } = await loadDeployment(deploymentId);

  const buildSessionRow = await repos.deployment.findBuildSessionByDeploymentId(deploymentId);

  const memSession = sessionManager.getSession(deploymentId);
  const isActive =
    memSession != null && !["ready", "failed", "cancelled"].includes(memSession.status);

  const logEntries = isActive
    ? (memSession?.logs ?? (buildSessionRow?.logs as LogEntry[] | null) ?? [])
    : ((buildSessionRow?.logs as LogEntry[] | null) ?? memSession?.logs ?? []);
  // Filter out step-metadata entries - they drive the progress bar, not the terminal
  const terminalEntries = logEntries
    .map((entry, eventId) => ({ entry, eventId }))
    .filter(({ entry }) => !(entry.step && entry.stepStatus));
  const logsText = terminalEntries.map(({ entry }) => entry.message).join("\n");
  const structuredLogs = terminalEntries.map(({ entry, eventId }) => ({
    text: entry.message,
    time: entry.timestamp,
    level: entry.level,
    serviceName: entry.serviceName,
    rawData: entry.rawData,
    eventId,
  }));
  const lastEventId = (() => {
    for (let index = logEntries.length - 1; index >= 0; index--) {
      const entry = logEntries[index];
      if (!(entry.step && entry.stepStatus)) {
        return index;
      }
    }
    return undefined;
  })();

  // In-memory session is real-time truth (updated every phase transition).
  // DB build-session row only moves queued → building → final, so it's stale during deploy.
  const effectiveStatus = memSession
    ? memSession.status
    : buildSessionRow
      ? buildSessionRow.status
      : dep.status;

  // Route state is always resolved live from route rows.
  const snapshot = dep.meta as DeploymentConfigSnapshot | null;
  const routeState = await resolveProjectRouteState(project);

  // Resolve the target server's display name (when this deployed to a server),
  // so the detail UI can show "Server · <name>" rather than a raw id.
  const targetServer = snapshot?.serverId
    ? await repos.server.get(snapshot.serverId).catch(() => null)
    : null;

  // Derive step progress from persisted log entries when no active session
  let currentStep = 0;
  let progress = 0;
  if (isActive) {
    // Truly active session - frontend gets live progress via SSE, don't override
    currentStep = undefined as unknown as number;
    progress = undefined as unknown as number;
  } else if (effectiveStatus === "ready") {
    currentStep = 5; // past deploy → Ready terminal (steps: prepare,clone,install,build,deploy,ready)
    progress = 100;
  } else {
    // Scan persisted logs for step events to find where it got to. Indices must
    // match the session-manager + the frontend STEPS array (prepare prepended).
    const STEP_INDEX: Record<string, number> = { prepare: 0, clone: 1, install: 2, build: 3, deploy: 4 };
    const STEP_PROGRESS: Record<string, number> = { prepare: 3, clone: 10, install: 30, build: 55, deploy: 80 };
    for (const entry of logEntries) {
      if (entry.step && entry.step in STEP_INDEX) {
        const idx = STEP_INDEX[entry.step];
        if (idx >= currentStep) {
          currentStep = idx;
          progress = STEP_PROGRESS[entry.step];
          // If this step completed, advance progress beyond it
          if (entry.stepStatus === "completed") {
            progress = STEP_PROGRESS[entry.step] + 10;
          }
        }
      }
    }
    // For failed/cancelled, keep progress where it stopped
  }

  // Per-phase durations for the build-phases panel. The raw log entries (before
  // the terminal filter) carry each step's running→completed events with
  // timestamps; pair them per step. Keyed by step name (prepare/clone/…).
  const phaseDurations: Record<string, number> = {};
  {
    const phaseStart: Record<string, number> = {};
    for (const entry of logEntries) {
      if (!entry.step || !entry.stepStatus) continue;
      const t = new Date(entry.timestamp).getTime();
      if (!Number.isFinite(t)) continue;
      if (entry.stepStatus === "running") {
        phaseStart[entry.step] = t;
      } else if (entry.stepStatus === "completed" && phaseStart[entry.step] != null) {
        phaseDurations[entry.step] = Math.max(0, t - phaseStart[entry.step]);
      }
    }
  }

  const [deploymentServices, projectServices] = await Promise.all([
    repos.service.listByDeployment(deploymentId).catch(() => []),
    repos.service.listByProject(project.id).catch(() => []),
  ]);
  const isServiceDeployment =
    snapshot?.serviceDeploymentMode === "services" ||
    (
      snapshot?.serviceDeploymentMode !== "single" &&
      (
        !!snapshot?.composeDeployment ||
        deploymentServices.length > 0 ||
        projectServices.length > 0 ||
        isMultiServiceProject(project)
      )
    );
  const projectType = isServiceDeployment
    ? ("services" as const)
    : snapshot?.runtimeMode === "docker"
      ? ("docker" as const)
      : ("app" as const);

  const composeData =
    projectType === "services"
      ? {
          composeDeployment: snapshot?.composeDeployment ?? null,
          serviceStatuses: deploymentServices.map((service) => ({
            serviceId: service.serviceId,
            status: service.status,
            containerId: service.containerId,
            hostPort: service.hostPort,
            ip: service.ip,
            imageRef: service.imageRef,
          })),
          services: projectServices
            .filter((service) => service.enabled)
            .map((service) => ({
              serviceId: service.id,
              serviceName: service.name,
              image: service.image,
              build: service.build,
            })),
        }
      : {};

  return {
    success: true,
    deployment_id: dep.id,
    project_id: project.id,
    status: effectiveStatus,
    is_active: isActive,
    logs: logsText,
    logEntries: structuredLogs,
    lastEventId,
    config: {
      repo: project.gitRepo,
      owner: project.gitOwner,
      projectName: project.name,
      framework: snapshot?.framework || project.framework,
      branch: dep.branch ?? project.gitBranch,
      // Build/deploy target — shown in Deployment Details. Sourced from the
      // immutable deployment snapshot so a loaded historical deploy is accurate.
      buildStrategy: snapshot?.buildStrategy,
      deployTarget: snapshot?.deployTarget,
      serverId: snapshot?.serverId,
      serverName: targetServer?.name ?? targetServer?.sshHost ?? null,
      publicEndpoints: routeState.publicEndpoints.map((endpoint) => ({
        id: endpoint.id,
        ...(endpoint.port !== undefined ? { port: String(endpoint.port) } : {}),
        ...(endpoint.targetPath ? { targetPath: endpoint.targetPath } : {}),
        domain: endpoint.domain || "",
        customDomain: endpoint.customDomain || "",
        domainType: endpoint.domainType || "free",
      })),
      buildCommand: snapshot?.buildCommand,
      outputDirectory: snapshot?.outputDirectory,
      installCommand: snapshot?.installCommand,
      startCommand: snapshot?.startCommand,
      rootDirectory: snapshot?.rootDirectory,
      hasServer: snapshot?.hasServer ?? !!snapshot?.startCommand?.trim(),
      serviceDeploymentMode: snapshot?.serviceDeploymentMode,
    },
    progress,
    currentStep,
    phaseDurations,
    screenshots: [],
    buildDurationMs: buildSessionRow?.durationMs ?? null,
    buildStartedAt: buildSessionRow?.startedAt?.toISOString() ?? null,
    failureMessage: effectiveStatus === "failed" ? dep.errorMessage || "" : "",
    warningMessage:
      effectiveStatus === "ready" ? snapshot?.composeDeployment?.warningMessage || "" : "",
    previousActiveDeploymentId: snapshot?.previousActiveDeploymentId ?? null,
    errorCode:
      dep.errorMessage?.includes("PORT_IN_USE") || dep.errorMessage?.includes("EADDRINUSE")
        ? "PORT_IN_USE"
        : undefined,
    projectType,
    ...composeData,
  };
}

// ─── Cancel build session ────────────────────────────────────────────────────

export async function cancelBuildSession(deploymentId: string) {
  const { dep, project } = await loadDeployment(deploymentId);

  if (!["queued", "building", "deploying"].includes(dep.status)) {
    throw new ForbiddenError("Cannot cancel a deployment that is not in progress");
  }

  const buildSession = await repos.deployment.findBuildSessionByDeploymentId(deploymentId);

  // 1. Abort the running build process. Best-effort - if the build already
  //    finished or never started this is a no-op.
  const { runtime } = platform();
  if (dep.status === "building" && buildSession) {
    await runtime.cancelBuild(buildSession.id).catch(() => {});
  }

  // 2. Tear down whatever the deploy had already provisioned. The shared
  //    deployment manifest enumerates ALL containers (deployment + each
  //    service) and ALL images (deployment + each service's built image),
  //    deduplicated. Volumes are deliberately NOT cleaned - cancel !=
  //    delete, and the user may retry.
  const manifest = await collectDeploymentManifest(dep, project).catch(
    (): CleanupManifest => ({ projectId: dep.projectId, resources: [] }),
  );
  if (manifest.resources.length > 0) {
    await executeCleanup(manifest).catch((err) => {
      // Per-item failures are already isolated inside executeCleanup, so we
      // only land here on an unexpected crash. Log and continue - cancel
      // still has to mark the deployment cancelled, leak or no leak.
      console.error(`[CANCEL] Cleanup crashed for ${dep.id}:`, err);
    });
  }

  // 3. Surface service-level cancellation in the SSE stream so the UI stops
  //    showing per-service spinners.
  const snapshot = dep.meta as DeploymentConfigSnapshot | null;
  if (snapshot?.serviceDeploymentMode !== "single") {
    const services = await repos.service.listByProject(dep.projectId).catch(() => []);
    for (const svc of services) {
      sessionManager.broadcastServiceStatus(dep.id, {
        serviceName: svc.name,
        serviceId: svc.id,
        status: "failed",
        error: "Deployment cancelled",
      });
    }
  }

  // 4. Persist the cancelled status + close the SSE stream.
  await repos.deployment.updateStatus(dep.id, "cancelled");
  if (buildSession) {
    await repos.deployment.finishBuildSession(buildSession.id, "cancelled", 0);
  }
  // Broadcast cancelled AFTER service statuses so UI receives the service updates first
  sessionManager.updateStatus(dep.id, "cancelled");

  return { success: true, message: "Deployment cancelled" };
}

// ─── Redeploy build session ─────────────────────────────────────────────────

export async function redeployBuildSession(
  ctx: RequestContext,
  deploymentId: string,
  opts?: { useExistingCommit?: boolean },
) {
  const { dep: oldDep, project } = await loadDeployment(deploymentId);
  // GitHub access gate (default-deny): a member can redeploy a
  // GitHub-backed project only when granted this repo.
  await assertGitHubRepoAccess(ctx, {
    owner: project.gitOwner,
    repo: project.gitRepo,
  });
  const resolvedBranch = await resolveProjectBranch(ctx, project, oldDep.branch ?? undefined);

  // Prefer the old deployment's snapshot; fall back to a fresh one from the project
  const frozenMeta = oldDep.meta as DeploymentConfigSnapshot | null;
  const meta = frozenMeta ?? buildConfigSnapshot(project, resolvedBranch);
  const branch = meta.branch || resolvedBranch;

  if (!frozenMeta) {
    const t = await resolveSnapshotTarget(project);
    meta.deployTarget = t.deployTarget;
    meta.serverId = t.serverId;
    meta.runtimeMode = t.runtimeMode;
    meta.buildStrategy = await settingsService.resolveStrategy(meta.framework, meta.buildStrategy, {
      deployTarget: meta.deployTarget,
    });
  }

  // Two redeploy modes:
  //   default            — rebuild against the LATEST commit on the branch.
  //                        This is "redeploy this branch" semantics; what
  //                        the auto-redeploy hooks and the main deploy UI use.
  //   useExistingCommit  — rebuild against THE SAME commit the old deployment
  //                        used. The dashboard offers this as a fallback when
  //                        an old deployment's artifact has been purged from
  //                        the retention window — gives the user back that
  //                        specific code without a manual git+redeploy dance.
  const { commitSha, commitMessage } =
    opts?.useExistingCommit && oldDep.commitSha
      ? {
          commitSha: oldDep.commitSha,
          commitMessage: oldDep.commitMessage ?? `Redeploy ${oldDep.commitSha.slice(0, 7)}`,
        }
      : await resolveLatestCommitInfo(ctx, project, branch);

  // ── Refresh compose services from current DB state ─────────────────────
  // The old snapshot's `composeServices` is frozen to whatever existed when
  // it was created. If the user added (or disabled) a service since then,
  // the redeploy must see the current shape - otherwise newly-added Postgres
  // / Redis / etc. rows would sit in the DB but never actually deploy.
  //
  // listProjectComposeServices returns BOTH kind="compose" AND
  // kind="monorepo" rows, so this refresh picks up newly-added sub-apps too
  // (e.g. a user adding `apps/admin` to a project that previously had only
  // `apps/web`).
  //
  // We deliberately don't touch `serviceDeploymentMode` - the downstream
  // pipeline gate (shouldUseProjectServicePipeline) re-queries the DB and
  // chooses the right mode regardless. Forcing it here would silently
  // override an explicit user choice on the original deployment.
  const currentComposeRows = await listProjectComposeServices(project.id).catch(() => []);
  const currentComposeServices = projectServicesToDeployableServices(
    currentComposeRows.filter((s) => s.enabled),
  );
  const refreshedMeta: DeploymentConfigSnapshot = {
    ...meta,
    composeServices: currentComposeServices.length > 0 ? currentComposeServices : undefined,
  };

  // ── Resolve rollback context (shared helper — single default) ─────────
  const { rollbackStrategy, commitShaBefore } = await resolveRollbackContext(
    project,
    branch,
  );

  const dep = await createQueuedDeployment({
    projectId: project.id,
    organizationId: project.organizationId ?? null,
    branch,
    commitSha,
    commitMessage,
    trigger: "redeploy",
    environment: oldDep.environment,
    framework: oldDep.framework || refreshedMeta.framework,
    meta: metaWithPrevious(refreshedMeta, project),
    envVars: oldDep.envVars as Record<string, string> | null,
    rollbackStrategy,
    commitShaBefore,
  });

  // Kick off the actual build. Without this, the new deployment row would
  // sit in "queued" status forever - the main deploy UI worked around this
  // by following up with POST /:id/build, but the dashboard's auto-redeploy
  // call sites (ServicesTab, ServiceDetailPanel) don't, and end-users see
  // a stuck "Queued" pill. startBuild is idempotent (see its guard below),
  // so the main UI's follow-up POST is a no-op instead of an error.
  await kickoffBuild(project, dep);

  return {
    success: true,
    deployment_id: dep.id,
    project_id: project.id,
  };
}

// ─── Start build from session ID (direct - no token) ─────────────────────────

export async function startBuild(deploymentId: string) {
  const { dep, project } = await loadDeployment(deploymentId);

  // Idempotent for already-running / completed deployments. redeploy now
  // auto-triggers the build, but the existing main-deploy UI still POSTs
  // /:id/build right after to attach its SSE stream - we want that POST to
  // succeed (so SSE attaches to the running session) instead of 400'ing.
  // Terminal states (ready/failed/cancelled) are also "do nothing, return ok".
  if (["building", "deploying", "ready", "failed", "cancelled"].includes(dep.status)) {
    return {
      success: true,
      deployment_id: dep.id,
      project_id: project.id,
      alreadyStarted: true as const,
    };
  }

  if (!["queued"].includes(dep.status)) {
    throw new ForbiddenError(`Build session is in an unexpected state: ${dep.status}`);
  }

  const buildSessionId = await kickoffBuild(project, dep);
  if (!buildSessionId) throw new NotFoundError("BuildSession for deployment", deploymentId);

  return {
    success: true,
    deployment_id: dep.id,
    project_id: project.id,
  };
}

// ─── Trigger deployment (internal build pipeline) ────────────────────────────

export async function triggerDeployment(
  ctx: RequestContext,
  data: {
    projectId: string;
    branch?: string;
    commitSha?: string;
    commitMessage?: string;
    environment?: string;
    trigger?: string;
    /**
     * Smart per-service deploy: when provided, only these services are
     * (re)built. Other enabled services are still tracked as
     * `service_deployment` rows with `status='skipped'` so the project
     * has a complete fan-out record for this deployment.
     */
    serviceIds?: string[];
    /**
     * How the rollback artifact for THIS deployment is preserved.
     * `'snapshot'` (default) → archive image + workspace.
     * `'git'`               → no artifact archive; rollback re-clones
     *                         at `commitShaBefore` and rebuilds.
     */
    rollbackStrategy?: "snapshot" | "git";
    /**
     * Commit SHA that was active BEFORE this deploy — the git-strategy
     * rollback target. Required for `rollbackStrategy: 'git'`.
     */
    commitShaBefore?: string;
    /**
     * Force a rebuild of every enabled service even if its root
     * directory's files didn't change. Set by the dashboard toggle, by
     * commit-message tokens (`[force]`, `[force-deploy]`,
     * `[redeploy-all]`), and by config-touch detection.
     */
    forceAll?: boolean;
    /**
     * Smart per-service routing for a MANUAL multi-service redeploy: trace the
     * files changed between the active deployment's commit and the new HEAD and
     * rebuild ONLY the affected services (same detection the webhook uses). Used
     * by the dashboard "Redeploy" button. Falls back to a full rebuild for
     * single-app projects, same-commit / config-only redeploys, or when the
     * diff can't be determined. Ignored when forceAll/serviceIds is set.
     */
    smartRoute?: boolean;
    /**
     * ATOMIC redeploy of a PAST deployment's exact config + env (git-strategy
     * rollback). When set, the new deployment ships this frozen snapshot + env
     * VERBATIM instead of rebuilding from the project's current (mutable)
     * columns / env_var table — so a rollback runs exactly what originally ran,
     * even if the project config or env changed since. Leave undefined for a
     * normal deploy (fresh snapshot from the project).
     */
    reuseSnapshot?: {
      meta: DeploymentConfigSnapshot;
      envVars: Record<string, string> | null;
    };
  },
) {
  const project = await repos.project.findById(data.projectId);
  if (!project) {
    throw new NotFoundError("Project", data.projectId);
  }
  // Org-membership verified at the route boundary. No userId equality
  // check here — that would block team members.

  if (!project.gitUrl && !project.localPath) {
    throw new ForbiddenError("Project has no git repository or local path configured");
  }
  // GitHub access gate (default-deny; webhook ctx is the org owner and
  // passes). Covers manual trigger / redeploy paths routed through here.
  await assertGitHubRepoAccess(ctx, {
    owner: project.gitOwner,
    repo: project.gitRepo,
  });

  const branch = await resolveProjectBranch(ctx, project, data.branch);
  const environment = data.environment ?? "production";

  await checkNoActiveBuild(project.id);

  // ATOMIC rollback path: reuse the target deployment's frozen snapshot verbatim
  // (its build config was already resolved + valid at original-deploy time).
  // Normal path: build a fresh snapshot from the project's current columns.
  const reuse = data.reuseSnapshot;
  const snapshot = reuse
    ? ({ ...reuse.meta } as DeploymentConfigSnapshot)
    : buildConfigSnapshot(project, branch);
  const routeState = await resolveProjectRouteState(project);

  // Resolve the snapshot's target (deployTarget + serverId + runtimeMode) from
  // the single source of truth shared with requestBuildAccess. buildConfigSnapshot
  // only knows cloud-vs-undefined (it can't see which server a self-hosted project
  // last deployed to — that lives in the deployment meta), so without this a
  // redeploy/webhook of a self-hosted *server* project loses its target and, on a
  // SaaS instance, defaults to cloud → wrong cloud preflight → 403. The resolver
  // gates serverId on target==="server" so a non-server deploy can't carry a stale
  // serverId. (reuse/rollback already carries the frozen target — leave it.)
  if (!reuse) {
    const resolvedTarget = await resolveSnapshotTarget(project);
    snapshot.deployTarget = resolvedTarget.deployTarget;
    snapshot.serverId = resolvedTarget.serverId;
    snapshot.runtimeMode = resolvedTarget.runtimeMode;
  }

  if (!reuse) {
    // Non-UI callers (CI, webhook, manual API) don't pass buildStrategy, so the
    // snapshot inherits `undefined` from buildConfigSnapshot and the later
    // fallback at resolveBuildGitToken collapses everything to "server". Run
    // it through resolveStrategy so a non-cloud stack with a "local" default
    // gets the same answer the UI would give — single source of truth. A reused
    // snapshot already froze its resolved strategy, so leave it untouched.
    snapshot.buildStrategy = await settingsService.resolveStrategy(
      snapshot.framework,
      snapshot.buildStrategy,
      { deployTarget: snapshot.deployTarget },
    );
  }

  // ── Preflight: validate config before creating any resources ────
  await runDeploymentPreflight(snapshot, routeState, {
    ctx,
    gitOwner: project.gitOwner,
    projectId: project.id,
  });

  // Env: a reused snapshot ships the EXACT encrypted env captured with the
  // target deployment (atomic rollback); a fresh deploy reads the project's
  // current (already-encrypted) env_var table.
  let encryptedEnvVars: Record<string, string> | null;
  if (reuse) {
    encryptedEnvVars = reuse.envVars;
  } else {
    const rawEnvMap = await repos.project.getEnvMap(project.id, environment);
    encryptedEnvVars = Object.keys(rawEnvMap).length > 0 ? rawEnvMap : null;
  }

  // ── Resolve commit info: fetch HEAD from GitHub if not provided ────
  let commitSha = data.commitSha;
  let commitMessage = data.commitMessage;
  if (!commitSha) {
    const head = await resolveLatestCommitInfo(ctx, project, branch);
    commitSha = head.commitSha;
    commitMessage = commitMessage ?? head.commitMessage;
  }

  // ── Resolve rollback context (shared helper — single default) ─────────
  // Explicit caller arg wins so the git-strategy rollback path can flip on a
  // per-rollback basis even when the project default is "snapshot".
  const { rollbackStrategy, commitShaBefore } = await resolveRollbackContext(project, branch, {
    rollbackStrategy: data.rollbackStrategy,
    commitShaBefore: data.commitShaBefore,
  });
  // ── Smart per-service routing (manual multi-service redeploy) ─────────
  // Resolve which services to (re)build via the shared helper — the one
  // resolution concern that mirrors the other resolveX helpers. Inert unless
  // smartRoute is set and the caller hasn't already targeted services / this
  // isn't a reuse rollback. See resolveSmartRoute for the fallback policy.
  const {
    forceAll: resolvedForceAll,
    serviceIds: resolvedServiceIds,
    changedPaths: resolvedChangedPaths,
  } = await resolveSmartRoute(ctx, project, {
    smartRoute: data.smartRoute,
    forceAll: data.forceAll,
    serviceIds: data.serviceIds,
    isReuse: !!reuse,
    commitSha,
    commitShaBefore,
  });

  const dep = await createQueuedDeployment({
    projectId: project.id,
    organizationId: project.organizationId ?? null,
    branch,
    commitSha,
    commitMessage,
    trigger: data.trigger ?? "manual",
    environment,
    framework: snapshot.framework,
    meta: metaWithPrevious(snapshot, project),
    envVars: encryptedEnvVars,
    rollbackStrategy,
    commitShaBefore,
    forceAll: resolvedForceAll,
    serviceIds: resolvedServiceIds,
    changedPaths: resolvedChangedPaths ?? null,
  });

  const buildSessionId = await kickoffBuild(project, dep);
  if (!buildSessionId) throw new Error("Build session was not created");

  return {
    deployment: dep,
  };
}
