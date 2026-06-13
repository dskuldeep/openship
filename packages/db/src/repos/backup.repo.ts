/**
 * Repos for the four backup tables. Single file because they're
 * conceptually one feature and the cross-references are tight.
 *
 *   destination  — per-user storage targets
 *   policy       — per-project (+ per-service override) rules
 *   run          — execution history (orchestrator FSM owns it)
 *   restore      — restore history (sibling of run)
 */

import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "../client";
import {
  backupDestination,
  backupPolicy,
  backupRestore,
  backupRun,
} from "../schema";

// ─── Inferred types ──────────────────────────────────────────────────────────

export type BackupDestination = typeof backupDestination.$inferSelect;
export type NewBackupDestination = typeof backupDestination.$inferInsert;
export type BackupPolicy = typeof backupPolicy.$inferSelect;
export type NewBackupPolicy = typeof backupPolicy.$inferInsert;
export type BackupRun = typeof backupRun.$inferSelect;
export type NewBackupRun = typeof backupRun.$inferInsert;
export type BackupRestore = typeof backupRestore.$inferSelect;
export type NewBackupRestore = typeof backupRestore.$inferInsert;

export type BackupRunStatus =
  | "queued"
  | "preparing"
  | "snapshotting"
  | "uploading"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "server_error";

/**
 * Restore FSM: queued → preparing → prepared → applying → terminal.
 *
 *   preparing  Downloading artifact + verifying sha256 into a staging
 *              area (Docker named volume or Cloud workspace sub-path).
 *              Service stays running, untouched.
 *   prepared   Staging complete. Waiting for user to confirm + apply.
 *              Can sit indefinitely. User can also cancel here and
 *              the staging area gets cleaned up.
 *   applying   Destructive phase: stop service → swap volume contents
 *              from staging → start service → verify health.
 */
export type BackupRestoreStatus =
  | "queued"
  | "preparing"
  | "prepared"
  | "applying"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "server_error";

const IN_FLIGHT_RUN_STATUSES: BackupRunStatus[] = [
  "queued",
  "preparing",
  "snapshotting",
  "uploading",
  "verifying",
];

const IN_FLIGHT_RESTORE_STATUSES: BackupRestoreStatus[] = [
  "queued",
  "preparing",
  "applying",
];
// Note: `prepared` is INTENTIONALLY not in-flight — it's a quiescent
// waiting state. Boot sweep doesn't kill prepared restores, the user
// gets to apply them after a restart.

// ─── Destination repo ────────────────────────────────────────────────────────

export function createBackupDestinationRepo(db: Database) {
  return {
    async list(userId: string): Promise<BackupDestination[]> {
      return db.query.backupDestination.findMany({
        where: and(
          eq(backupDestination.userId, userId),
          isNull(backupDestination.deletedAt),
        ),
        orderBy: (t, { asc }) => [asc(t.createdAt)],
      });
    },

    async findById(id: string): Promise<BackupDestination | undefined> {
      return db.query.backupDestination.findFirst({
        where: and(
          eq(backupDestination.id, id),
          isNull(backupDestination.deletedAt),
        ),
      });
    },

    async findByName(
      userId: string,
      name: string,
    ): Promise<BackupDestination | undefined> {
      return db.query.backupDestination.findFirst({
        where: and(
          eq(backupDestination.userId, userId),
          eq(backupDestination.name, name),
          isNull(backupDestination.deletedAt),
        ),
      });
    },

    async create(data: NewBackupDestination): Promise<BackupDestination> {
      const [row] = await db.insert(backupDestination).values(data).returning();
      return row;
    },

    async update(
      id: string,
      data: Partial<Omit<NewBackupDestination, "id" | "userId" | "createdAt">>,
    ): Promise<BackupDestination | undefined> {
      const [row] = await db
        .update(backupDestination)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(backupDestination.id, id))
        .returning();
      return row;
    },

    async setLastVerified(
      id: string,
      ok: boolean,
      error?: string,
    ): Promise<void> {
      await db
        .update(backupDestination)
        .set({
          lastVerifiedAt: ok ? new Date() : backupDestination.lastVerifiedAt,
          lastVerifyError: ok ? null : (error ?? "Verification failed"),
          updatedAt: new Date(),
        })
        .where(eq(backupDestination.id, id));
    },

    /** Soft delete. Refuses if any active policy still references it —
     *  caller catches and surfaces the friendly error. */
    async softDelete(id: string): Promise<{ ok: true } | { ok: false; reason: string }> {
      const referencingCount = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(backupPolicy)
        .where(
          and(
            eq(backupPolicy.destinationId, id),
            isNull(backupPolicy.deletedAt),
          ),
        )
        .then((rows) => Number(rows[0]?.count ?? 0));

      if (referencingCount > 0) {
        return {
          ok: false,
          reason: `Destination is referenced by ${referencingCount} active backup ${
            referencingCount === 1 ? "policy" : "policies"
          }. Remove those policies first.`,
        };
      }

      await db
        .update(backupDestination)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(backupDestination.id, id));
      return { ok: true };
    },
  };
}

// ─── Policy repo ─────────────────────────────────────────────────────────────

export function createBackupPolicyRepo(db: Database) {
  return {
    async listByProject(projectId: string): Promise<BackupPolicy[]> {
      return db.query.backupPolicy.findMany({
        where: and(
          eq(backupPolicy.projectId, projectId),
          isNull(backupPolicy.deletedAt),
        ),
      });
    },

    async findById(id: string): Promise<BackupPolicy | undefined> {
      return db.query.backupPolicy.findFirst({
        where: and(eq(backupPolicy.id, id), isNull(backupPolicy.deletedAt)),
      });
    },

    /** Project-level default — the row with serviceId IS NULL. */
    async findProjectDefault(projectId: string): Promise<BackupPolicy | undefined> {
      return db.query.backupPolicy.findFirst({
        where: and(
          eq(backupPolicy.projectId, projectId),
          isNull(backupPolicy.serviceId),
          isNull(backupPolicy.deletedAt),
        ),
      });
    },

    /** Per-service override — the row with serviceId = X. */
    async findServiceOverride(
      projectId: string,
      serviceId: string,
    ): Promise<BackupPolicy | undefined> {
      return db.query.backupPolicy.findFirst({
        where: and(
          eq(backupPolicy.projectId, projectId),
          eq(backupPolicy.serviceId, serviceId),
          isNull(backupPolicy.deletedAt),
        ),
      });
    },

    /**
     * Effective policy for (project, service) — picks ONE row.
     * Override wins; falls back to project default; null if neither.
     */
    async findEffective(
      projectId: string,
      serviceId: string | null,
    ): Promise<BackupPolicy | undefined> {
      if (serviceId) {
        const override = await this.findServiceOverride(projectId, serviceId);
        if (override) return override;
      }
      return this.findProjectDefault(projectId);
    },

    async findByWebhookToken(token: string): Promise<BackupPolicy | undefined> {
      return db.query.backupPolicy.findFirst({
        where: and(
          eq(backupPolicy.webhookToken, token),
          isNull(backupPolicy.deletedAt),
        ),
      });
    },

    /** Every enabled policy with a non-null cron expression. Used by
     *  the cron-trigger boot reconcile to register repeat jobs. */
    async listEnabledScheduled(): Promise<BackupPolicy[]> {
      return db.query.backupPolicy.findMany({
        where: and(
          isNull(backupPolicy.deletedAt),
          eq(backupPolicy.enabled, true),
          sql`${backupPolicy.cronExpression} IS NOT NULL`,
        ),
      });
    },

    /** Every enabled policy with `trigger_on_pre_deploy = true` for a
     *  given project. Used by the pre-deploy hook in the deployment
     *  lifecycle to fire backups before swapping the active deployment. */
    async listEnabledPreDeployByProject(projectId: string): Promise<BackupPolicy[]> {
      return db.query.backupPolicy.findMany({
        where: and(
          eq(backupPolicy.projectId, projectId),
          isNull(backupPolicy.deletedAt),
          eq(backupPolicy.enabled, true),
          eq(backupPolicy.triggerOnPreDeploy, true),
        ),
      });
    },

    async create(data: NewBackupPolicy): Promise<BackupPolicy> {
      const [row] = await db.insert(backupPolicy).values(data).returning();
      return row;
    },

    async update(
      id: string,
      data: Partial<Omit<NewBackupPolicy, "id" | "createdAt">>,
    ): Promise<BackupPolicy | undefined> {
      const [row] = await db
        .update(backupPolicy)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(backupPolicy.id, id))
        .returning();
      return row;
    },

    async markWebhookFired(id: string): Promise<void> {
      await db
        .update(backupPolicy)
        .set({ webhookLastFiredAt: new Date(), updatedAt: new Date() })
        .where(eq(backupPolicy.id, id));
    },

    async softDelete(id: string): Promise<void> {
      await db
        .update(backupPolicy)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(backupPolicy.id, id));
    },
  };
}

// ─── Run repo ────────────────────────────────────────────────────────────────

export function createBackupRunRepo(db: Database) {
  return {
    async listByUser(
      userId: string,
      opts?: { limit?: number; projectId?: string; serviceId?: string },
    ): Promise<BackupRun[]> {
      const conditions = [eq(backupRun.userId, userId), isNull(backupRun.deletedAt)];
      if (opts?.projectId) conditions.push(eq(backupRun.projectId, opts.projectId));
      if (opts?.serviceId) conditions.push(eq(backupRun.serviceId, opts.serviceId));
      return db.query.backupRun.findMany({
        where: and(...conditions),
        orderBy: (t, { desc }) => [desc(t.startedAt)],
        limit: opts?.limit ?? 100,
      });
    },

    async findById(id: string): Promise<BackupRun | undefined> {
      return db.query.backupRun.findFirst({
        where: eq(backupRun.id, id),
      });
    },

    /** Queued runs awaiting a worker. Used by the in-process runner's
     *  boot requeue + periodic poll, both of which sweep work that a
     *  prior process left orphaned. Ordered oldest-first so we work
     *  through the backlog in FIFO order. */
    async listQueued(limit = 50): Promise<BackupRun[]> {
      return db.query.backupRun.findMany({
        where: eq(backupRun.status, "queued"),
        orderBy: (t, { asc }) => [asc(t.startedAt)],
        limit,
      });
    },

    async create(data: NewBackupRun): Promise<BackupRun> {
      const [row] = await db.insert(backupRun).values(data).returning();
      return row;
    },

    /** FSM state transition. Always bumps lastEventAt; sets finishedAt
     *  on terminal states. */
    async transition(
      id: string,
      status: BackupRunStatus,
      patch?: Partial<Omit<NewBackupRun, "id" | "userId" | "startedAt">>,
    ): Promise<void> {
      const TERMINAL: BackupRunStatus[] = [
        "succeeded",
        "failed",
        "cancelled",
        "server_error",
      ];
      const finishing = TERMINAL.includes(status);
      await db
        .update(backupRun)
        .set({
          status,
          lastEventAt: new Date(),
          ...(finishing ? { finishedAt: new Date() } : {}),
          ...(patch ?? {}),
        })
        .where(eq(backupRun.id, id));
    },

    /** Mark every in-flight run as server_error. Called at boot to
     *  reconcile after a crash. */
    async sweepStaleRuns(reason: string): Promise<number> {
      const result = await db
        .update(backupRun)
        .set({
          status: "server_error",
          finishedAt: new Date(),
          lastEventAt: new Date(),
          errorMessage: reason,
        })
        .where(
          and(
            inArray(backupRun.status, IN_FLIGHT_RUN_STATUSES),
            isNull(backupRun.finishedAt),
          ),
        )
        .returning();
      return result.length;
    },

    /** Used by the retention prune job (Chunk 2). */
    async listSucceededOlderThan(
      destinationId: string,
      cutoff: Date,
    ): Promise<BackupRun[]> {
      return db.query.backupRun.findMany({
        where: and(
          eq(backupRun.destinationId, destinationId),
          eq(backupRun.status, "succeeded"),
          isNull(backupRun.deletedAt),
          lt(backupRun.finishedAt, cutoff),
        ),
      });
    },

    async softDelete(id: string): Promise<void> {
      await db
        .update(backupRun)
        .set({ deletedAt: new Date() })
        .where(eq(backupRun.id, id));
    },

    /** Toggle the "protect this backup" flag. When set, retention
     *  prune skips this run regardless of count/age caps. */
    async setRetentionLock(id: string, lockedUntil: Date | null): Promise<void> {
      await db
        .update(backupRun)
        .set({ retentionLockedUntil: lockedUntil })
        .where(eq(backupRun.id, id));
    },
  };
}

// ─── Restore repo ────────────────────────────────────────────────────────────

export function createBackupRestoreRepo(db: Database) {
  return {
    async listByUser(
      userId: string,
      opts?: { limit?: number },
    ): Promise<BackupRestore[]> {
      return db.query.backupRestore.findMany({
        where: eq(backupRestore.userId, userId),
        orderBy: (t, { desc }) => [desc(t.startedAt)],
        limit: opts?.limit ?? 100,
      });
    },

    async findById(id: string): Promise<BackupRestore | undefined> {
      return db.query.backupRestore.findFirst({
        where: eq(backupRestore.id, id),
      });
    },

    /** Find any non-terminal restore for a given source run. Used when
     *  the user re-clicks Prepare on a row that's already prepared:
     *  we surface the existing restore instead of double-staging. */
    async findActiveByRunId(runId: string): Promise<BackupRestore | undefined> {
      return db.query.backupRestore.findFirst({
        where: and(
          eq(backupRestore.runId, runId),
          inArray(backupRestore.status, [
            "queued",
            "preparing",
            "prepared",
            "applying",
          ]),
        ),
      });
    },

    async create(data: NewBackupRestore): Promise<BackupRestore> {
      const [row] = await db.insert(backupRestore).values(data).returning();
      return row;
    },

    async transition(
      id: string,
      status: BackupRestoreStatus,
      patch?: Partial<Omit<NewBackupRestore, "id" | "userId" | "startedAt">>,
    ): Promise<void> {
      const TERMINAL: BackupRestoreStatus[] = [
        "succeeded",
        "failed",
        "cancelled",
        "server_error",
      ];
      const finishing = TERMINAL.includes(status);
      await db
        .update(backupRestore)
        .set({
          status,
          lastEventAt: new Date(),
          ...(finishing ? { finishedAt: new Date() } : {}),
          ...(patch ?? {}),
        })
        .where(eq(backupRestore.id, id));
    },

    async sweepStaleRestores(reason: string): Promise<number> {
      const result = await db
        .update(backupRestore)
        .set({
          status: "server_error",
          finishedAt: new Date(),
          lastEventAt: new Date(),
          errorMessage: reason,
        })
        .where(
          and(
            inArray(backupRestore.status, IN_FLIGHT_RESTORE_STATUSES),
            isNull(backupRestore.finishedAt),
          ),
        )
        .returning();
      return result.length;
    },
  };
}
