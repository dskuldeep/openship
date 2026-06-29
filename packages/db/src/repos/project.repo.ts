import { eq, and, isNull, inArray, desc, sql, type SQL } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { project, envVar } from "../schema";
import { member } from "../schema/organization";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Project = typeof project.$inferSelect;
export type NewProject = typeof project.$inferInsert;
export type EnvVar = typeof envVar.$inferSelect;
export type NewEnvVar = typeof envVar.$inferInsert;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build Drizzle conditions for env var queries scoped by project/environment/service */
function envVarScope(projectId: string, environment?: string, serviceId?: string | null): SQL[] {
  const conditions: SQL[] = [eq(envVar.projectId, projectId)];
  if (environment) {
    conditions.push(eq(envVar.environment, environment));
  }
  if (serviceId === null) {
    // Explicitly project-level only
    conditions.push(isNull(envVar.serviceId));
  } else if (serviceId) {
    conditions.push(eq(envVar.serviceId, serviceId));
  }
  return conditions;
}

// ─── Repository ──────────────────────────────────────────────────────────────

export function createProjectRepo(db: Database) {
  return {
    // ── Projects ───────────────────────────────────────────────────────

    async findById(id: string) {
      return db.query.project.findFirst({
        where: and(eq(project.id, id), isNull(project.deletedAt)),
      });
    },

    /** Slug uniqueness scoped to one org. */
    async findBySlugInOrg(organizationId: string, slug: string) {
      return db.query.project.findFirst({
        where: and(
          eq(project.organizationId, organizationId),
          eq(project.slug, slug),
          isNull(project.deletedAt),
        ),
      });
    },

    /**
     * Find a project by slug without scoping to a user. Use ONLY for slugs
     * that are deterministic and globally unique (e.g. `webmail-<serverId>`),
     * never for user-facing slugs where collisions across users are expected.
     */
    async findFirstBySlug(slug: string) {
      return db.query.project.findFirst({
        where: and(eq(project.slug, slug), isNull(project.deletedAt)),
      });
    },

    /** Find all projects linked to a given git owner/repo (for webhook dispatch) */
    async findByGitRepo(owner: string, repo: string) {
      const ownerKey = owner.toLowerCase();
      const repoKey = repo.toLowerCase();
      return db.query.project.findMany({
        where: and(
          sql`lower(${project.gitOwner}) = ${ownerKey}`,
          sql`lower(${project.gitRepo}) = ${repoKey}`,
          isNull(project.deletedAt),
        ),
      });
    },

    async listByApp(appId: string) {
      return db.query.project.findMany({
        where: and(eq(project.appId, appId), isNull(project.deletedAt)),
        orderBy: [desc(project.createdAt)],
      });
    },

    /**
     * List every project visible to a user — across ALL orgs they're a
     * member of. Resolves via the `member` join (not a stamped user_id
     * column, which doesn't exist anymore). Useful for "show me
     * everything I have access to" views like cross-org dashboards.
     *
     * For scoped lookups on the user's CURRENT org, prefer
     * `listByOrganization(activeOrgId, ...)`.
     */
    async listForUser(userId: string, opts?: { page?: number; perPage?: number }) {
      const page = opts?.page ?? 1;
      const perPage = opts?.perPage ?? 20;
      const offset = (page - 1) * perPage;

      const rows = await db
        .select({ project })
        .from(project)
        .innerJoin(member, eq(member.organizationId, project.organizationId))
        .where(and(eq(member.userId, userId), isNull(project.deletedAt)))
        .orderBy(desc(project.createdAt))
        .limit(perPage)
        .offset(offset);

      const [{ value: total }] = await db
        .select({ value: sql<number>`count(*)` })
        .from(project)
        .innerJoin(member, eq(member.organizationId, project.organizationId))
        .where(and(eq(member.userId, userId), isNull(project.deletedAt)));

      return {
        rows: rows.map((r) => r.project),
        total: Number(total),
        page,
        perPage,
      };
    },

    /**
     * Org-scoped list. Replaces listByUser in multi-user controllers —
     * returns every project visible to the active organization.
     * Membership check is enforced at the middleware layer; this just
     * scopes the rows.
     */
    async listByOrganization(
      organizationId: string,
      opts?: { page?: number; perPage?: number },
    ) {
      const page = opts?.page ?? 1;
      const perPage = opts?.perPage ?? 20;
      const offset = (page - 1) * perPage;

      const rows = await db.query.project.findMany({
        where: and(eq(project.organizationId, organizationId), isNull(project.deletedAt)),
        orderBy: [desc(project.createdAt)],
        limit: perPage,
        offset,
      });

      const [{ value: total }] = await db
        .select({ value: sql<number>`count(*)` })
        .from(project)
        .where(and(eq(project.organizationId, organizationId), isNull(project.deletedAt)));

      return { rows, total: Number(total), page, perPage };
    },

    /** Org-scoped findById — verifies the project belongs to the org. */
    async findByIdInOrganization(id: string, organizationId: string) {
      return db.query.project.findFirst({
        where: and(eq(project.id, id), eq(project.organizationId, organizationId)),
      });
    },

    /**
     * Same as listForUser but filtered to production environments only.
     * Used for the "primary" view that hides preview branch deploys.
     */
    async listPrimaryForUser(userId: string, opts?: { page?: number; perPage?: number }) {
      const page = opts?.page ?? 1;
      const perPage = opts?.perPage ?? 20;
      const offset = (page - 1) * perPage;

      const condition = and(
        eq(member.userId, userId),
        eq(project.environmentSlug, "production"),
        isNull(project.deletedAt),
      );

      const rows = await db
        .select({ project })
        .from(project)
        .innerJoin(member, eq(member.organizationId, project.organizationId))
        .where(condition)
        .orderBy(desc(project.createdAt))
        .limit(perPage)
        .offset(offset);

      const [{ value: total }] = await db
        .select({ value: sql<number>`count(*)` })
        .from(project)
        .innerJoin(member, eq(member.organizationId, project.organizationId))
        .where(condition);

      return {
        rows: rows.map((r) => r.project),
        total: Number(total),
        page,
        perPage,
      };
    },

    async create(data: Omit<NewProject, "id">) {
      const id = generateId("proj");
      const row = { id, ...data };
      await db.insert(project).values(row);
      return { ...row, createdAt: new Date(), updatedAt: new Date() } as Project;
    },

    async update(id: string, data: Partial<NewProject>) {
      await db
        .update(project)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(project.id, id));
    },

    /**
     * Atomically consume the one-shot `forceDeployNext` flag.
     *
     * Returns `true` if the flag was set and has now been cleared (the caller
     * should treat this as a force-deploy). Returns `false` if it was already
     * false. Two concurrent webhooks can both observe the flag with a naive
     * read-then-update, so this is a single conditional UPDATE that only
     * touches the row when the flag is true and reports back whether it won.
     */
    async consumeForceDeployNext(id: string): Promise<boolean> {
      const rows = await db
        .update(project)
        .set({ forceDeployNext: false, updatedAt: new Date() })
        .where(and(eq(project.id, id), eq(project.forceDeployNext, true)))
        .returning();
      return rows.length > 0;
    },

    async updateByApp(appId: string, data: Partial<NewProject>) {
      await db
        .update(project)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(project.appId, appId), isNull(project.deletedAt)));
    },

    /** Update favicon cache metadata without touching the user-visible updatedAt field. */
    async updateFaviconCache(
      id: string,
      data: { favicon?: string | null; faviconCheckedAt?: Date | null },
    ) {
      const patch: Partial<NewProject> = {};

      if (Object.prototype.hasOwnProperty.call(data, "favicon")) {
        patch.favicon = data.favicon ?? null;
      }
      if (Object.prototype.hasOwnProperty.call(data, "faviconCheckedAt")) {
        patch.faviconCheckedAt = data.faviconCheckedAt ?? null;
      }

      if (Object.keys(patch).length === 0) return;

      await db.update(project).set(patch).where(eq(project.id, id));
    },

    /** Soft-delete a project */
    async softDelete(id: string) {
      await db
        .update(project)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(project.id, id));
    },

    /**
     * Hard-delete a project row. Lets FK ON DELETE CASCADE drop dependent
     * rows (deployment, service, env_var, domain, backup_*). Only call from
     * the atomic teardown flow, AFTER remote/runtime cleanup has succeeded —
     * the soft-delete + per-table hard-delete path in project-cleanup is the
     * legacy variant that left some dependents around.
     */
    async deleteHard(id: string) {
      await db.delete(project).where(eq(project.id, id));
    },

    /**
     * Atomically mark the project as "teardown in progress". Returns true
     * when this caller claimed the flag, false if another teardown is
     * already running (and the caller should reject with a 409). Uses a
     * conditional UPDATE so the read+write is a single row-locked op.
     */
    async claimDeletion(id: string): Promise<boolean> {
      const rows = await db
        .update(project)
        .set({ deletionInProgress: true, updatedAt: new Date() })
        .where(
          and(
            eq(project.id, id),
            eq(project.deletionInProgress, false),
            isNull(project.deletedAt),
          ),
        )
        .returning();
      return rows.length > 0;
    },

    /** Release the deletion-in-progress flag — call on every failure path so
     *  the row isn't stuck refusing all writes after a partial teardown. */
    async clearDeletionInProgress(id: string) {
      await db
        .update(project)
        .set({ deletionInProgress: false, updatedAt: new Date() })
        .where(eq(project.id, id));
    },

    /**
     * Boot-time sweep of stuck deletion locks. A `deletionInProgress=true`
     * flag can only be left behind by a teardown that died mid-flight — no
     * teardown survives a process restart — so at startup every such flag is
     * necessarily stale and must be cleared, otherwise the project refuses all
     * future deletes with "Another delete is already running" forever. Mirrors
     * backupRun.sweepStaleRuns / backupRestore.sweepStaleRestores. Returns the
     * number of locks cleared.
     */
    async clearStaleDeletions(): Promise<number> {
      const rows = await db
        .update(project)
        .set({ deletionInProgress: false, updatedAt: new Date() })
        .where(eq(project.deletionInProgress, true))
        .returning();
      return rows.length;
    },

    /** Set the active deployment for a project */
    async setActiveDeployment(projectId: string, deploymentId: string | null) {
      await db
        .update(project)
        .set({ activeDeploymentId: deploymentId, updatedAt: new Date() })
        .where(eq(project.id, projectId));
    },

    /**
     * Bind a project to its Openship Cloud workspace. The unique
     * partial index on `(cloud_workspace_id) WHERE NOT NULL` enforces
     * one-project-per-workspace at the DB layer — a unique violation
     * here means another project row already claims this workspace,
     * which is a real drift bug the caller must surface.
     *
     * `cloudWorkspaceId IS NOT NULL` is the canonical "this is a
     * cloud project" test downstream; no separate deployTarget column.
     */
    async setCloudWorkspaceId(projectId: string, cloudWorkspaceId: string) {
      await db
        .update(project)
        .set({
          cloudWorkspaceId,
          updatedAt: new Date(),
        })
        .where(eq(project.id, projectId));
    },

    /**
     * Clear the cloud workspace binding (detach). Leaves deployTarget
     * untouched — the caller decides whether to demote to self-hosted
     * or keep the project as "cloud but unbound" pending a fresh deploy.
     */
    async clearCloudWorkspaceId(projectId: string) {
      await db
        .update(project)
        .set({ cloudWorkspaceId: null, updatedAt: new Date() })
        .where(eq(project.id, projectId));
    },

    /**
     * List every cloud-bound project in an org. Used by the drift
     * endpoint to diff against Oblien's `workspaces.list`. A project
     * is "cloud-bound" iff it has a non-null cloudWorkspaceId — that
     * column is the single source of truth, no separate deployTarget.
     *
     * Returns the minimal shape the diff needs — id, name, slug, and
     * the workspace binding — not the full project record, so the
     * dashboard payload stays small.
     */
    async listCloudProjectsByOrganization(organizationId: string) {
      return db
        .select({
          id: project.id,
          name: project.name,
          slug: project.slug,
          cloudWorkspaceId: project.cloudWorkspaceId,
        })
        .from(project)
        .where(
          and(
            eq(project.organizationId, organizationId),
            sql`${project.cloudWorkspaceId} IS NOT NULL`,
            isNull(project.deletedAt),
          ),
        );
    },

    // ── Environment variables ──────────────────────────────────────────

    async listEnvVars(projectId: string, environment?: string, serviceId?: string | null) {
      return db.query.envVar.findMany({
        where: and(...envVarScope(projectId, environment, serviceId)),
      });
    },

    /** Lookup a single env var by id — needed by permission.resolveResourceOrg. */
    async findEnvVarById(id: string) {
      return db.query.envVar.findFirst({ where: eq(envVar.id, id) });
    },

    async setEnvVar(data: Omit<NewEnvVar, "id">) {
      const id = generateId("env");
      const row = { id, ...data };
      await db.insert(envVar).values(row);
      return row;
    },

    async updateEnvVar(id: string, value: string) {
      await db.update(envVar).set({ value, updatedAt: new Date() }).where(eq(envVar.id, id));
    },

    async deleteEnvVar(id: string) {
      await db.delete(envVar).where(eq(envVar.id, id));
    },

    /**
     * Full REPLACE of env vars for a project + environment scope (optionally a
     * service). Destructive: deletes the whole scope then inserts `vars`.
     * Atomic — the delete + insert run in one transaction so an insert failure
     * can't leave the scope wiped. Prefer `mergeEnvVars` for partial edits
     * (it never touches untouched vars / masked secrets).
     */
    async bulkSetEnvVars(
      projectId: string,
      environment: string,
      vars: { key: string; value: string; isSecret?: boolean }[],
      serviceId?: string | null,
    ) {
      await db.transaction(async (tx) => {
        await tx
          .delete(envVar)
          .where(and(...envVarScope(projectId, environment, serviceId ?? null)));

        if (vars.length === 0) return;

        await tx.insert(envVar).values(
          vars.map((v) => ({
            id: generateId("env"),
            projectId,
            environment,
            serviceId: serviceId ?? null,
            key: v.key,
            value: v.value,
            isSecret: v.isSecret ?? false,
          })),
        );
      });
    },

    /**
     * MERGE env vars: upsert the given keys, delete the given keys, and leave
     * every other var (including untouched masked secrets) exactly as-is. Only
     * the keys in (deletes ∪ upserts) are touched, all in one transaction.
     * This is the safe path for a per-variable editor where secret VALUES the
     * user didn't change are never re-sent.
     */
    async mergeEnvVars(
      projectId: string,
      environment: string,
      upserts: { key: string; value: string; isSecret?: boolean }[],
      deletes: string[],
      serviceId?: string | null,
    ) {
      const affectedKeys = Array.from(
        new Set([...deletes, ...upserts.map((u) => u.key)]),
      );
      if (affectedKeys.length === 0) return;

      await db.transaction(async (tx) => {
        await tx.delete(envVar).where(
          and(
            ...envVarScope(projectId, environment, serviceId ?? null),
            inArray(envVar.key, affectedKeys),
          ),
        );

        if (upserts.length > 0) {
          await tx.insert(envVar).values(
            upserts.map((v) => ({
              id: generateId("env"),
              projectId,
              environment,
              serviceId: serviceId ?? null,
              key: v.key,
              value: v.value,
              isSecret: v.isSecret ?? false,
            })),
          );
        }
      });
    },

    /** Get a map of env vars for injection into builds/containers */
    async getEnvMap(
      projectId: string,
      environment: string,
      serviceId?: string | null,
    ): Promise<Record<string, string>> {
      const rows = await db.query.envVar.findMany({
        where: and(...envVarScope(projectId, environment, serviceId)),
      });
      const map: Record<string, string> = {};
      for (const row of rows) {
        map[row.key] = row.value;
      }
      return map;
    },
  };
}
