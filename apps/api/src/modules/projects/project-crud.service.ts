/**
 * Project CRUD service - create, read, update, list, ensure.
 */

import { repos, type Deployment, type NewProject, type Project, type Server } from "@repo/db";
import { slugify, NotFoundError, ConflictError, ValidationError, SYSTEM, safeErrorMessage } from "@repo/core";
import type { ResourceConfig } from "@repo/adapters";
import { encodeResources } from "../../lib/resources";
import { normalizeRollbackWindow } from "../../lib/release-retention";
import { env } from "../../config";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import type { RequestContext } from "../../lib/request-context";
import { getRepository, listBranches as listGitHubBranches, getLatestCommit } from "../github/github.service";
import {
  deriveEnvironmentPublicEndpoints,
  deriveNextProjectRouteState,
  persistProjectRouteState,
  reapplyProjectLiveRoutes,
  resolveProjectRouteState,
  syncProjectRouteState,
  type ProjectRouteState,
} from "../domains/project-route.service";
import type {
  TCreateProjectBody,
  TCreateProjectEnvironmentBody,
  TUpdateProjectBody,
} from "./project.schema";

type EnsureProjectBody = TCreateProjectBody & { projectId?: string };

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** The deploy target + server aren't project columns — they live in the active
 *  deployment's `meta` JSON. This is the one place that parse happens, so every
 *  caller (enrichProject, its batch variant, getGitInfo) reads them the same
 *  way. Server *name* resolution stays at the call site because single vs batch
 *  fetch it differently (one `server.get` vs a prefetched map). */
function readDeployMeta(dep: Deployment | null | undefined): {
  deployTarget: string | null;
  serverId: string | null;
} {
  const meta = (dep?.meta ?? null) as { deployTarget?: string; serverId?: string } | null;
  return {
    deployTarget: meta?.deployTarget ?? null,
    serverId: meta?.serverId ?? null,
  };
}

/** Enrich a project row with computed fields. `deployTarget` is the
 *  only signal the dashboard needs — `deployTarget === "cloud"` IS
 *  the cloud-project test; the dashboard combines it with its own
 *  CloudContext.connected state to decide whether to render the
 *  "Reconnect Openship Cloud" gate. No duplicate booleans here. */
export async function enrichProject(p: Project) {
  const production = p.resources as ResourceConfig | null;
  const build = p.buildResources as ResourceConfig | null;

  // Resolve deploy target + server (id + name) from the active deployment's meta
  let deployTarget: string | null = null;
  let serverId: string | null = null;
  let serverName: string | null = null;
  if (p.activeDeploymentId) {
    const dep = await repos.deployment.findById(p.activeDeploymentId);
    ({ deployTarget, serverId } = readDeployMeta(dep));
    if (serverId) {
      const server = await repos.server.get(serverId);
      serverName = server?.name || server?.sshHost || null;
    }
  }

  return {
    ...p,
    deployTarget,
    serverName,
    resources: encodeResources(production, build, p.sleepMode ?? "auto_sleep", p.port ?? 3000),
  };
}

/**
 * Batch variant of enrichProject — pre-fetches every active deployment
 * + every referenced server in two SQL round trips for N projects,
 * then enriches each project from the lookup maps. Used by the home
 * page (getHome) where the per-project query fan-out is the hottest
 * source of N+1 latency.
 *
 * Per-project query count: 0 (data is pre-fetched).
 * Total SQL cost: 1 (deployment.findManyById) + 1 (server.getMany).
 */
export async function enrichProjectsBatch(
  projects: Project[],
): Promise<Array<Awaited<ReturnType<typeof enrichProject>>>> {
  const activeDeploymentIds = projects
    .map((p) => p.activeDeploymentId)
    .filter((id): id is string => Boolean(id));
  const deployments = await repos.deployment
    .findManyById(activeDeploymentIds)
    .catch(() => new Map<string, Deployment>());

  const serverIds = new Set<string>();
  for (const d of deployments.values()) {
    const meta = d.meta as { serverId?: string } | null;
    if (meta?.serverId) serverIds.add(meta.serverId);
  }
  const servers = await repos.server
    .getMany(Array.from(serverIds))
    .catch(() => new Map<string, Server>());

  return projects.map((p) => {
    const production = p.resources as ResourceConfig | null;
    const build = p.buildResources as ResourceConfig | null;

    let deployTarget: string | null = null;
    let serverId: string | null = null;
    let serverName: string | null = null;
    if (p.activeDeploymentId) {
      const dep = deployments.get(p.activeDeploymentId);
      ({ deployTarget, serverId } = readDeployMeta(dep));
      if (serverId) {
        const server = servers.get(serverId);
        serverName = server?.name || server?.sshHost || null;
      }
    }

    return {
      ...p,
      deployTarget,
      serverName,
      resources: encodeResources(production, build, p.sleepMode ?? "auto_sleep", p.port ?? 3000),
    };
  });
}

function projectGitUrl(owner?: string | null, repo?: string | null) {
  return owner && repo ? `https://github.com/${owner}/${repo}.git` : undefined;
}

function resolveProjectSource(data: TCreateProjectBody) {
  const safeLocalPath = data.localPath && !env.CLOUD_MODE ? data.localPath : undefined;
  const gitOwner = safeLocalPath ? undefined : data.gitOwner;
  const gitRepo = safeLocalPath ? undefined : data.gitRepo;

  return {
    safeLocalPath,
    gitOwner,
    gitRepo,
    gitProvider: safeLocalPath ? "local" : (data.gitProvider ?? "github"),
    gitUrl: projectGitUrl(gitOwner, gitRepo),
  };
}

function normalizeEnvironmentSlug(input?: string | null, fallback = "production") {
  return slugify(input || fallback) || fallback;
}

function environmentNameFromSlug(slug: string) {
  return (
    slug
      .split("-")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || "Production"
  );
}

async function ensureProjectApp(
  data: TCreateProjectBody,
  slug: string,
  organizationId: string,
) {
  let app = await repos.projectApp.findBySlugInOrg(organizationId, slug);
  if (app) return { app, created: false };

  const source = resolveProjectSource(data);

  app = await repos.projectApp.create({
    organizationId,
    name: data.name,
    slug,
    gitProvider: source.gitProvider,
    gitOwner: source.gitOwner,
    gitRepo: source.gitRepo,
    gitUrl: source.gitUrl,
    installationId: data.installationId,
  });

  return { app, created: true };
}

function buildProductionProjectInput(
  appId: string,
  data: TCreateProjectBody,
  slug: string,
  routing: ProjectRouteState,
  organizationId: string,
): Omit<NewProject, "id"> {
  const source = resolveProjectSource(data);

  return {
    organizationId,
    appId,
    name: data.name,
    slug,
    environmentName: "Production",
    environmentSlug: "production",
    environmentType: "production",
    localPath: source.safeLocalPath,
    gitProvider: source.gitProvider,
    gitOwner: source.gitOwner,
    gitRepo: source.gitRepo,
    gitBranch: data.gitBranch ?? "main",
    gitUrl: source.gitUrl,
    installationId: data.installationId,
    framework: data.framework ?? "unknown",
    packageManager: data.packageManager ?? "npm",
    installCommand: data.installCommand,
    buildCommand: data.buildCommand,
    outputDirectory: data.outputDirectory,
    productionPaths: data.productionPaths,
    rootDirectory: data.rootDirectory,
    startCommand: data.startCommand,
    buildImage: data.buildImage,
    productionMode: data.productionMode ?? (data.hasServer === false ? "static" : "host"),
    port: data.port ?? 3000,
    hasServer: data.hasServer ?? true,
    hasBuild: data.hasBuild ?? true,
    workspacePrepareCommand:
      data.projectType === "monorepo"
        ? data.monorepoWorkspace?.prepareCommand ?? null
        : null,
    rollbackWindow:
      data.rollbackWindow !== undefined ? normalizeRollbackWindow(data.rollbackWindow) : null,
    cloudArchiveStrategy: data.cloudArchiveStrategy ?? undefined,
  };
}

async function persistMonorepoApps(
  projectId: string,
  data: TCreateProjectBody,
): Promise<void> {
  if (data.projectType !== "monorepo" || !data.monorepoApps?.length) return;

  await repos.service.syncMonorepoApps(
    projectId,
    data.monorepoApps.map((app) => ({
      name: app.name,
      rootDirectory: app.rootDirectory,
      framework: app.framework ?? null,
      packageManager: app.packageManager ?? null,
      buildImage: app.buildImage ?? null,
      installCommand: app.installCommand ?? null,
      buildCommand: app.buildCommand ?? null,
      startCommand: app.startCommand ?? null,
      outputDirectory: app.outputDirectory ?? null,
      port: app.port ?? null,
      enabled: app.enabled ?? true,
      exposed: app.exposed ?? true,
      exposedPort: app.port != null ? String(app.port) : null,
      domain: app.domain ?? null,
      customDomain: app.customDomain ?? null,
      domainType: app.domainType ?? "free",
      environment: app.environment ?? {},
    })),
  );
}

async function createProductionProject(
  data: TCreateProjectBody,
  slug: string,
  organizationId: string,
) {
  const { app, created: appCreated } = await ensureProjectApp(data, slug, organizationId);
  const routing = deriveNextProjectRouteState({
    slug,
  }, {
    nextPublicEndpoints: data.publicEndpoints,
    slug,
  });

  try {
    const created = await repos.project.create(
      buildProductionProjectInput(app.id, data, slug, routing, organizationId),
    );
    await persistProjectRouteState(created.id, routing.publicEndpoints);
    await persistMonorepoApps(created.id, data);
    return created;
  } catch (err) {
    if (appCreated) {
      await repos.projectApp.softDelete(app.id).catch(() => {});
    }
    throw err;
  }
}

async function uniqueProjectSlug(organizationId: string, baseSlug: string) {
  let slug = baseSlug;
  let suffix = 2;

  while (await repos.project.findBySlugInOrg(organizationId, slug)) {
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  return slug;
}

function environmentSummary(
  p: Project,
  latestStatus?: string | null,
  primaryDomain?: string | null,
) {
  return {
    id: p.id,
    name: p.environmentName,
    slug: p.environmentSlug,
    type: p.environmentType,
    gitBranch: p.gitBranch ?? "main",
    projectSlug: p.slug,
    activeDeploymentId: p.activeDeploymentId,
    latestDeploymentStatus: latestStatus ?? null,
    primaryDomain,
  };
}

function selectDisplayProject(rows: Project[]): Project | null {
  if (rows.length === 0) return null;
  return rows.find((row) => row.environmentSlug === "production") ?? rows[0]!;
}

function selectProjectForBranch(rows: Project[], branch?: string | null): Project | null {
  if (rows.length === 0) return null;

  const normalizedBranch = branch?.trim();
  if (normalizedBranch) {
    const byBranch = rows.find((row) => row.gitBranch === normalizedBranch);
    if (byBranch) return byBranch;
  }

  return selectDisplayProject(rows);
}

async function findProjectByAppSlug(
  organizationId: string,
  slug: string,
  branch?: string | null,
): Promise<Project | null> {
  const app = await repos.projectApp.findBySlugInOrg(organizationId, slug);
  if (app) {
    return selectProjectForBranch(await repos.project.listByApp(app.id), branch);
  }

  return (await repos.project.findBySlugInOrg(organizationId, slug)) ?? null;
}

// ─── Ensure project (create or return existing) ─────────────────────────────

export async function ensureProject(
  data: EnsureProjectBody,
  organizationId: string,
) {
  const nameSlug = slugify(data.name);
  const desiredSlug = data.slug || nameSlug;

  let project: Project | null = null;
  if (data.projectId) {
    project = (await repos.project.findById(data.projectId)) ?? null;
    assertResourceInOrg(project, "Project", organizationId, data.projectId);
  }

  if (!project) {
    project = await findProjectByAppSlug(organizationId, nameSlug, data.gitBranch);
  }
  if (!project && desiredSlug !== nameSlug) {
    project = await findProjectByAppSlug(organizationId, desiredSlug, data.gitBranch);
  }
  let created = false;

  if (!project) {
    project = await createProductionProject(
      data,
      desiredSlug,
      organizationId,
    );
    created = true;
  } else {
    // Defensive: if we matched an existing project but its org_id doesn't
    // match the caller's active org, refuse. The auto-switch middleware
    // should have made these match before we get here, but the bare
    // ensure path can be called from edge code paths (CLI, deploy hooks).
    if (project.organizationId !== organizationId) {
      throw new NotFoundError("Project", data.projectId ?? desiredSlug);
    }
    const update: Record<string, unknown> = {};
    if (data.framework !== undefined) update.framework = data.framework;
    if (data.packageManager !== undefined) update.packageManager = data.packageManager;
    if (data.installCommand !== undefined) update.installCommand = data.installCommand;
    if (data.buildCommand !== undefined) update.buildCommand = data.buildCommand;
    if (data.outputDirectory !== undefined) update.outputDirectory = data.outputDirectory;
    if (data.productionPaths !== undefined) update.productionPaths = data.productionPaths;
    if (data.rootDirectory !== undefined) update.rootDirectory = data.rootDirectory;
    if (data.startCommand !== undefined) update.startCommand = data.startCommand;
    if (data.buildImage !== undefined) update.buildImage = data.buildImage;
    if (data.port !== undefined) update.port = data.port;
    if (data.productionMode !== undefined) update.productionMode = data.productionMode;
    if (data.hasServer !== undefined) {
      update.hasServer = data.hasServer;
      if (data.productionMode === undefined && data.hasServer === false) {
        update.productionMode = "static";
      }
    }
    if (data.hasBuild !== undefined) update.hasBuild = data.hasBuild;
    if (data.projectType === "monorepo" && data.monorepoWorkspace !== undefined) {
      update.workspacePrepareCommand = data.monorepoWorkspace.prepareCommand ?? null;
    }
    if (data.slug !== undefined && data.slug !== project.slug) {
      const existingProject = await repos.project.findBySlugInOrg(organizationId, data.slug);
      if (existingProject && existingProject.id !== project.id) {
        throw new ConflictError(`Project slug "${data.slug}" already exists`);
      }

      const existingApp = await repos.projectApp.findBySlugInOrg(organizationId, data.slug);
      if (existingApp && existingApp.id !== project.appId) {
        throw new ConflictError(`Project slug "${data.slug}" already exists`);
      }

      update.slug = data.slug;
    }
    if (data.gitBranch !== undefined && (data.projectId || !project.gitBranch)) {
      update.gitBranch = data.gitBranch;
    }
    if (data.localPath !== undefined) {
      const safePath = data.localPath && !env.CLOUD_MODE ? data.localPath : null;
      update.localPath = safePath;
      if (safePath) {
        update.gitProvider = "local";
        update.gitUrl = null;
      }
    }
    if (data.rollbackWindow !== undefined) {
      update.rollbackWindow =
        data.rollbackWindow === null ? null : normalizeRollbackWindow(data.rollbackWindow);
    }
    if (data.cloudArchiveStrategy !== undefined) {
      update.cloudArchiveStrategy = data.cloudArchiveStrategy;
    }

    if (Object.keys(update).length > 0) {
      await repos.project.update(project.id, update);
    }

    // Reconcile routes AFTER persisting the project (best-effort) so a route-sync
    // failure can't discard the field edits we just committed; the next deploy
    // re-syncs routes. Same ordering as updateOptions.
    if (
      data.publicEndpoints !== undefined ||
      update.slug !== undefined ||
      update.port !== undefined
    ) {
      await syncProjectRouteState(project, {
        nextPublicEndpoints: data.publicEndpoints,
        slug: typeof update.slug === "string" ? update.slug : project.slug,
      }).catch((err) =>
        console.warn(`[ensureProject] route sync failed (non-fatal): ${safeErrorMessage(err)}`),
      );
    }

    if (
      project.appId &&
      typeof update.slug === "string" &&
      project.environmentSlug === "production"
    ) {
      await repos.projectApp.update(project.appId, { slug: update.slug });
    }

    // Re-sync monorepo sub-apps if the request carries them. The sync method
    // is idempotent - adds new rows, updates existing, removes stale ones.
    await persistMonorepoApps(project.id, data);
  }

  return { success: true, project_id: project.id, created };
}

// ─── List projects ───────────────────────────────────────────────────────────

/**
 * List projects in scope, one display row per project app.
 *
 * Drives off `project` directly (not `project_app`) so the list and the detail
 * endpoint (`getProject`) agree on what's visible. The previous implementation
 * filtered apps first, which hid projects whose `project_app` row had been
 * soft-deleted while the project itself was still alive - a state the detail
 * endpoint happily returned, leaving the project reachable by URL but absent
 * from every listing.
 */
export async function listProjects(
  organizationId: string,
  opts?: { page?: number; perPage?: number },
) {
  const page = opts?.page ?? 1;
  const perPage = opts?.perPage ?? 20;

  // organizationId is required across the codebase — the route-level
  // requirePermission middleware ensures it's set before the controller runs.
  const { rows: projects } = await repos.project.listByOrganization(
    organizationId,
    { page: 1, perPage: 1000 },
  );

  const byApp = new Map<string, Project[]>();
  for (const p of projects) {
    const list = byApp.get(p.appId) ?? [];
    list.push(p);
    byApp.set(p.appId, list);
  }

  const displays = Array.from(byApp.values())
    .map(selectDisplayProject)
    .filter((p): p is Project => !!p)
    .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));

  const start = (page - 1) * perPage;
  const rows = displays.slice(start, start + perPage);

  return { rows, total: displays.length, page, perPage };
}

// ─── Get single project ──────────────────────────────────────────────────────

export async function getProject(projectId: string, organizationId: string) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);
  return enrichProject(p);
}

// ─── Create project ──────────────────────────────────────────────────────────

/** @scope org — only reads organizationId as a DB key. */
export async function createProject(
  data: TCreateProjectBody,
  organizationId: string,
) {
  const slug = slugify(data.name);

  const { total } = await repos.projectApp.listByOrganization(organizationId, {
    page: 1,
    perPage: 1,
  });
  if (total >= SYSTEM.PROJECTS.MAX_PER_USER) {
    throw new ValidationError(`Project limit reached (${SYSTEM.PROJECTS.MAX_PER_USER})`);
  }

  const existing = await findProjectByAppSlug(organizationId, slug);
  if (existing) throw new ConflictError(`Project "${data.name}" already exists`);

  const p = await createProductionProject(data, slug, organizationId);

  return enrichProject(p);
}

// ─── Update project ──────────────────────────────────────────────────────────

export async function updateProject(
  projectId: string,
  data: TUpdateProjectBody,
  organizationId: string,
) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  const update: Record<string, unknown> = { ...data };
  if (data.name && data.name !== p.name) {
    const newSlug = slugify(data.name);
    const existing = await repos.project.findBySlugInOrg(organizationId, newSlug);
    if (existing && existing.id !== projectId) {
      throw new ConflictError(`Project "${data.name}" already exists`);
    }
    update.slug = newSlug;
  }

  if (data.gitOwner || data.gitRepo) {
    const owner = data.gitOwner ?? p.gitOwner;
    const repo = data.gitRepo ?? p.gitRepo;
    if (owner && repo) {
      update.gitUrl = `https://github.com/${owner}/${repo}.git`;
    }
  }

  if (data.rollbackWindow !== undefined) {
    update.rollbackWindow =
      data.rollbackWindow === null ? null : normalizeRollbackWindow(data.rollbackWindow);
  }

  // ── monorepoSharedPaths validation ──────────────────────────────────
  // Reject any prefix that overlaps an existing service's rootDirectory:
  // configuring `packages/` as a shared path when `packages/web` is a
  // deployable service would force-rebuild every service on every push
  // to web (defeating the point of smart per-service deploys).
  if (data.monorepoSharedPaths !== undefined && data.monorepoSharedPaths !== null) {
    const normalize = (s: string) =>
      s.trim().replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
    const prefixes = data.monorepoSharedPaths
      .map(normalize)
      .filter((s) => s.length > 0);
    if (prefixes.length > 0) {
      const services = await repos.service.listByProject(projectId).catch(() => []);
      const serviceRoots = services
        .map((s) => normalize(s.rootDirectory ?? ""))
        .filter((s) => s.length > 0);
      const overlap = prefixes.find((prefix) =>
        serviceRoots.some(
          (root) => root === prefix || root.startsWith(`${prefix}/`) || prefix.startsWith(`${root}/`),
        ),
      );
      if (overlap) {
        throw new ValidationError(
          `monorepoSharedPaths prefix "${overlap}" overlaps an existing service rootDirectory — a shared-path force would defeat smart per-service deploys`,
        );
      }
    }
    // Normalize empty → null so the change detector's null-check fires.
    update.monorepoSharedPaths = prefixes.length > 0 ? data.monorepoSharedPaths : null;
  }

  // ── defaultRollbackStrategy ────────────────────────────────────────
  if (data.defaultRollbackStrategy !== undefined) {
    if (data.defaultRollbackStrategy !== "git" && data.defaultRollbackStrategy !== "snapshot") {
      throw new ValidationError(
        `defaultRollbackStrategy must be "git" or "snapshot"`,
      );
    }
    update.defaultRollbackStrategy = data.defaultRollbackStrategy;
  }

  await repos.project.update(projectId, update);

  // Reconcile routes AFTER persisting the project (best-effort) — a route-sync
  // failure must not discard the field edits already committed; the next deploy
  // re-syncs. Same ordering as updateOptions.
  if (
    data.publicEndpoints !== undefined ||
    update.slug !== undefined ||
    update.port !== undefined
  ) {
    // Snapshot the live hostnames before the sync so re-application can tear
    // down any the edit drops.
    const beforeState = await resolveProjectRouteState(p).catch(() => null);
    const previousHostnames = beforeState?.projectDomains.map((d) => d.hostname) ?? [];

    await syncProjectRouteState(p, {
      nextPublicEndpoints: data.publicEndpoints,
      slug: typeof update.slug === "string" ? update.slug : p.slug,
    }).catch((err) =>
      console.warn(`[updateProject] route sync failed (non-fatal): ${safeErrorMessage(err)}`),
    );

    // Re-apply the live route so a domain/port edit takes effect without a
    // redeploy (best-effort — the DB rows are already committed).
    const refreshed = await repos.project.findById(projectId);
    if (refreshed) {
      await reapplyProjectLiveRoutes(refreshed, previousHostnames).catch((err) =>
        console.warn(
          `[updateProject] live route re-apply failed (non-fatal): ${safeErrorMessage(err)}`,
        ),
      );
    }
  }

  if (p.appId) {
    const appUpdate: Record<string, unknown> = {};
    if (typeof update.name === "string") appUpdate.name = update.name;
    if (typeof update.slug === "string" && p.environmentSlug === "production")
      appUpdate.slug = update.slug;
    if (typeof update.gitProvider === "string") appUpdate.gitProvider = update.gitProvider;
    if (typeof update.gitOwner === "string" || update.gitOwner === null)
      appUpdate.gitOwner = update.gitOwner;
    if (typeof update.gitRepo === "string" || update.gitRepo === null)
      appUpdate.gitRepo = update.gitRepo;
    if (typeof update.gitUrl === "string" || update.gitUrl === null)
      appUpdate.gitUrl = update.gitUrl;
    if (typeof update.installationId === "number" || update.installationId === null)
      appUpdate.installationId = update.installationId;
    if (Object.keys(appUpdate).length > 0) {
      await repos.projectApp.update(p.appId, appUpdate);
    }
  }
  const updated = await repos.project.findById(projectId);
  return enrichProject(updated!);
}

// ─── Project environments ───────────────────────────────────────────────────

export async function listProjectEnvironments(
  projectId: string,
  organizationId: string,
) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  const rows = await repos.project.listByApp(p.appId);
  const enriched = await Promise.all(
    rows.map(async (row) => {
      const [latest, primary] = await Promise.all([
        repos.deployment.findLatestByProject(row.id),
        repos.domain.getPrimaryByProject(row.id),
      ]);
      return environmentSummary(row, latest?.status ?? null, primary?.hostname ?? null);
    }),
  );

  return enriched.sort((a, b) => {
    if (a.slug === "production") return -1;
    if (b.slug === "production") return 1;
    return a.name.localeCompare(b.name);
  });
}

export async function createProjectEnvironment(
  projectId: string,
  ctx: RequestContext,
  data: TCreateProjectEnvironmentBody,
) {
  const { userId, organizationId } = ctx;
  const base = await repos.project.findById(projectId);
  assertResourceInOrg(base, "Project", organizationId, projectId);

  const environmentSlug = normalizeEnvironmentSlug(
    data.environmentSlug ?? data.environmentName,
    "development",
  );
  const environmentName = data.environmentName?.trim() || environmentNameFromSlug(environmentSlug);
  const environmentType =
    data.environmentType ?? (environmentSlug === "production" ? "production" : "development");

  const existing = (await repos.project.listByApp(base.appId)).find(
    (row) => row.environmentSlug === environmentSlug,
  );
  if (existing) {
    throw new ConflictError(`Environment "${environmentName}" already exists`);
  }

  const app = await repos.projectApp.findById(base.appId);
  const projectSlug = await uniqueProjectSlug(
    organizationId,
    environmentSlug === "production" ? base.slug : `${app?.slug ?? base.slug}-${environmentSlug}`,
  );

  let productionBranch = base.gitBranch ?? undefined;
  if (!productionBranch && environmentType === "production" && base.gitOwner && base.gitRepo) {
    // userId here is the actor who triggered the action — used to authorize
    // the GitHub call against their installation token.
    const repository = await getRepository(ctx, base.gitOwner, base.gitRepo);
    productionBranch = repository.default_branch;
  }

  const gitBranch =
    data.gitBranch?.trim() ||
    (environmentType === "production" ? (productionBranch ?? "main") : environmentSlug);

  if ((data.sourceMode ?? "branch") === "branch" && base.gitOwner && base.gitRepo && gitBranch) {
    const branches = await listGitHubBranches(ctx, base.gitOwner, base.gitRepo);
    const exists = branches.some((branch) => branch.name === gitBranch);
    if (!exists) {
      throw new ValidationError(`Branch "${gitBranch}" was not found for ${base.gitOwner}/${base.gitRepo}`);
    }
  }

  const created = await repos.project.create({
    organizationId,
    appId: base.appId,
    name: app?.name ?? base.name,
    slug: projectSlug,
    environmentName,
    environmentSlug,
    environmentType,
    localPath: base.localPath,
    gitProvider: app?.gitProvider ?? base.gitProvider,
    gitOwner: app?.gitOwner ?? base.gitOwner,
    gitRepo: app?.gitRepo ?? base.gitRepo,
    gitBranch,
    gitUrl: app?.gitUrl ?? base.gitUrl,
    installationId: app?.installationId ?? base.installationId,
    framework: base.framework,
    packageManager: base.packageManager,
    installCommand: base.installCommand,
    buildCommand: base.buildCommand,
    outputDirectory: base.outputDirectory,
    productionPaths: base.productionPaths,
    rootDirectory: base.rootDirectory,
    startCommand: base.startCommand,
    buildImage: base.buildImage,
    productionMode: base.productionMode,
    port: base.port,
    hasServer: base.hasServer,
    hasBuild: base.hasBuild,
    resources: base.resources,
    buildResources: base.buildResources,
    sleepMode: base.sleepMode,
    rollbackWindow: base.rollbackWindow,
    cloudArchiveStrategy: base.cloudArchiveStrategy,
    webhookId: null,
    webhookDomain: null,
    autoDeploy: base.autoDeploy,
  });

  const baseRouteState = await resolveProjectRouteState(base);
  await persistProjectRouteState(
    created.id,
    deriveEnvironmentPublicEndpoints(baseRouteState.publicEndpoints, projectSlug),
  );

  return environmentSummary(created);
}

// ─── Git info ────────────────────────────────────────────────────────────────

/**
 * Commit-drift check for the "your project is outdated" banner. Compares the
 * branch HEAD on GitHub to the commit the ACTIVE deployment shipped. Fetched
 * on-demand by the project page. Conservative: an unknown HEAD (API failure /
 * rate limit) or a project with no successful deploy yet reports `behind:false`
 * so we never show a false "outdated" nudge.
 */
export async function getProjectCommitStatus(
  ctx: RequestContext,
  projectId: string,
  organizationId: string,
) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  // Only GitHub-backed projects have a remote branch HEAD to compare against.
  if (!p.gitOwner || !p.gitRepo) {
    return { supported: false as const };
  }

  const branch = p.gitBranch?.trim() || "main";
  const head = await getLatestCommit(ctx, p.gitOwner, p.gitRepo, branch).catch(() => null);

  let deployedSha: string | null = null;
  if (p.activeDeploymentId) {
    const dep = await repos.deployment.findById(p.activeDeploymentId).catch(() => null);
    deployedSha = dep?.commitSha ?? null;
  }

  const latestSha = head?.sha ?? null;
  const behind = Boolean(latestSha && deployedSha && latestSha !== deployedSha);

  // Is the latest commit already being deployed? If so the dashboard suppresses
  // the "new commit available — redeploy" nudge: there's nothing to redeploy,
  // it's in flight. (Only worth checking when we're actually behind.)
  const latestInProgress = behind && latestSha
    ? Boolean(await repos.deployment.findInProgressByCommit(projectId, latestSha))
    : false;

  return {
    supported: true as const,
    behind,
    latestInProgress,
    branch,
    latestSha,
    latestMessage: head?.message ?? null,
    deployedSha,
  };
}

export async function getGitInfo(projectId: string, organizationId: string) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  // Resolve deploy target from active deployment meta
  let deployTarget: string | null = null;
  if (p.activeDeploymentId) {
    const dep = await repos.deployment.findById(p.activeDeploymentId);
    ({ deployTarget } = readDeployMeta(dep));
  }

  return {
    gitProvider: p.gitProvider,
    gitOwner: p.gitOwner,
    gitRepo: p.gitRepo,
    gitBranch: p.gitBranch,
    gitUrl: p.gitUrl,
    installationId: p.installationId,
    webhookId: p.webhookId,
    webhookDomain: p.webhookDomain,
    autoDeploy: p.autoDeploy,
    defaultRollbackStrategy: p.defaultRollbackStrategy,
    deployTarget,
  };
}

export async function setBranch(
  projectId: string,
  branch: string,
  organizationId: string,
) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  await repos.project.update(projectId, { gitBranch: branch });
  return { success: true, branch };
}

// ─── Build options ───────────────────────────────────────────────────────────

export async function updateOptions(
  projectId: string,
  options: Record<string, unknown>,
  organizationId: string,
) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  const update: Record<string, unknown> = {};
  if (options.buildCommand !== undefined) update.buildCommand = options.buildCommand;
  if (options.installCommand !== undefined) update.installCommand = options.installCommand;
  if (options.outputDirectory !== undefined) update.outputDirectory = options.outputDirectory;
  if (options.productionPaths !== undefined) update.productionPaths = options.productionPaths;
  if (options.rootDirectory !== undefined) update.rootDirectory = options.rootDirectory;
  if (options.startCommand !== undefined) update.startCommand = options.startCommand;
  if (options.productionPort !== undefined) update.port = options.productionPort;
  if (options.packageManager !== undefined) update.packageManager = options.packageManager;
  if (options.buildImage !== undefined) update.buildImage = options.buildImage;
  if (options.framework !== undefined) update.framework = options.framework;
  if (options.productionMode !== undefined) update.productionMode = options.productionMode;
  if (options.hasServer !== undefined) {
    update.hasServer = options.hasServer;
    if (options.productionMode === undefined && options.hasServer === false) {
      update.productionMode = "static";
    }
  }
  if (options.hasBuild !== undefined) update.hasBuild = options.hasBuild;
  // Runtime isolation mode (bare/docker) — editable in the Runtime tab; read by
  // buildConfigSnapshot so every deploy/redeploy respects the saved choice.
  // (Resources have their own dedicated path — projectsApi.setResources — so
  // we deliberately do NOT also write them here.)
  if (options.runtimeMode === "bare" || options.runtimeMode === "docker") {
    update.runtimeMode = options.runtimeMode;
  }

  // Persist the canonical config FIRST, then reconcile routes (best-effort) on a
  // port change. Ordering the project write before route-sync means a route-sync
  // failure can't leave config unsaved — and the next deploy re-syncs routes.
  if (Object.keys(update).length > 0) {
    await repos.project.update(projectId, update);
  }

  if (update.port !== undefined) {
    await syncProjectRouteState(p, { slug: p.slug });
  }

  const updated = await repos.project.findById(projectId);
  return enrichProject(updated!);
}

// ─── Project deployments ─────────────────────────────────────────────────────

export async function listProjectDeployments(
  projectId: string,
  organizationId: string,
  opts?: { page?: number; perPage?: number; environment?: string },
) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  return repos.deployment.listByProject(projectId, opts);
}

// ─── Deployment session ──────────────────────────────────────────────────────

export async function getLatestDeploymentSession(
  projectId: string,
  organizationId: string,
) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  if (!p.activeDeploymentId) {
    return { session: null };
  }

  const session = await repos.deployment.findBuildSessionByDeploymentId(p.activeDeploymentId);
  return {
    session: session
      ? {
          id: session.id,
          deploymentId: session.deploymentId,
          status: session.status,
          durationMs: session.durationMs,
        }
      : null,
  };
}


