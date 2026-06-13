/**
 * Retention prune — runs daily, applies each policy's retention rules.
 *
 * Two retention dimensions, evaluated independently per policy:
 *   - `retainCount` — keep at most N most-recent succeeded runs.
 *   - `retainDays`  — drop succeeded runs older than N days.
 *
 * For runs outside the keep-set, delete their artifacts from the
 * destination and soft-delete the backup_run row. Honors
 * `retentionLockedUntil` ("Protect this backup", Chunk 3 UI).
 *
 * Used to be a BullMQ worker; now it's a function registered with the
 * JobRunner via scheduleRecurring. Works identically on BullMQ + in-
 * process backends.
 */

import { repos, type BackupPolicy, type BackupRun } from "@repo/db";
import { resolveDestination } from "@repo/adapters";
import { toAdapterRow } from "../backup-destinations/hydrate-server";
import { getJobRunner } from "../../lib/job-runner";
import { safeErrorMessage } from "../../lib/safe-error";

const RETENTION_JOB_ID = "retention-prune-daily";
// 03:17 UTC — off the every-night-at-3am peak.
const RETENTION_CRON = "17 3 * * *";

export async function runRetentionSweep(): Promise<{
  policiesProcessed: number;
  runsDeleted: number;
  errors: number;
}> {
  const stats = { policiesProcessed: 0, runsDeleted: 0, errors: 0 };

  // Walk cron-scheduled policies. Manual-only policies are excluded —
  // the user opted into fire-and-forget there.
  const policies = await repos.backupPolicy.listEnabledScheduled();

  for (const policy of policies) {
    try {
      stats.runsDeleted += await prunePolicy(policy);
      stats.policiesProcessed += 1;
    } catch (err) {
      stats.errors += 1;
      console.warn(
        `[retention-prune] policy ${policy.id} failed: ${safeErrorMessage(err)}`,
      );
    }
  }
  return stats;
}

async function prunePolicy(policy: BackupPolicy): Promise<number> {
  if (!policy.retainCount && !policy.retainDays) return 0;

  const destinationId = policy.destinationId;
  const allRuns = await repos.backupRun.listByUser(
    policy.createdBy ?? "system",
    { projectId: policy.projectId, limit: 1000 },
  );
  const candidates = allRuns
    .filter((r) => r.destinationId === destinationId)
    .filter((r) => r.status === "succeeded")
    .filter((r) => !r.deletedAt)
    .filter((r) => {
      if (r.retentionLockedUntil && r.retentionLockedUntil > new Date()) {
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      const aT = a.finishedAt?.getTime() ?? 0;
      const bT = b.finishedAt?.getTime() ?? 0;
      return bT - aT;
    });

  const cutoffDate = policy.retainDays
    ? new Date(Date.now() - policy.retainDays * 24 * 60 * 60 * 1000)
    : null;

  const toDelete: BackupRun[] = [];
  let kept = 0;
  for (const run of candidates) {
    let drop = false;
    if (policy.retainCount && kept >= policy.retainCount) drop = true;
    if (cutoffDate && run.finishedAt && run.finishedAt < cutoffDate) drop = true;
    if (drop) toDelete.push(run);
    else kept += 1;
  }

  if (toDelete.length === 0) return 0;

  const destinationRow = await repos.backupDestination.findById(destinationId);
  if (!destinationRow) return 0;
  const adapterRow = await toAdapterRow(destinationRow);
  const destination = resolveDestination(adapterRow);

  let dropped = 0;
  for (const run of toDelete) {
    try {
      const artifactKeys = Array.isArray(run.artifacts)
        ? run.artifacts
            .map((a) =>
              typeof a === "object" && a && "key" in a
                ? (a as { key: string }).key
                : null,
            )
            .filter((k): k is string => typeof k === "string")
        : [];
      if (run.manifestKey) artifactKeys.push(run.manifestKey);

      if (artifactKeys.length > 0) {
        await destination.deleteMany(artifactKeys);
      }
      await repos.backupRun.softDelete(run.id);
      dropped += 1;
    } catch (err) {
      console.warn(
        `[retention-prune] failed to drop run ${run.id}: ${safeErrorMessage(err)}`,
      );
    }
  }
  return dropped;
}

/**
 * Boot-time registration. Idempotent (registering the same jobId
 * replaces). Survives restarts because the runner is the persistence
 * layer (BullMQ) or re-registers on every boot (in-process).
 */
export async function scheduleRetentionPrune(): Promise<void> {
  const runner = await getJobRunner();
  await runner.scheduleRecurring({
    jobId: RETENTION_JOB_ID,
    cronExpression: RETENTION_CRON,
    onTick: async () => {
      const stats = await runRetentionSweep();
      if (stats.runsDeleted > 0 || stats.errors > 0) {
        console.log(
          `[retention-prune] ${stats.policiesProcessed} policies, ` +
            `${stats.runsDeleted} runs dropped, ${stats.errors} errors`,
        );
      }
    },
  });
}
