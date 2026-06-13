/**
 * Manual trigger — "Backup now" button. The simplest of the four
 * trigger types: a user hits an HTTP endpoint, we build a
 * BackupTrigger value, and the orchestrator does the rest.
 *
 * Authorization: route layer guarantees the caller owns the project
 * AND the destination tied to the policy. Both checks happen in
 * `triggerManualBackup` before we enqueue.
 */

import { repos } from "@repo/db";
import { backupOrchestrator } from "../backup.orchestrator";

export async function triggerManualBackup(opts: {
  policyId: string;
  userId: string;
  clientIp?: string;
}): Promise<{ runId: string }> {
  const policy = await repos.backupPolicy.findById(opts.policyId);
  if (!policy) {
    throw new Error("Backup policy not found");
  }
  const project = await repos.project.findById(policy.projectId);
  if (!project || project.userId !== opts.userId) {
    throw new Error("Backup policy not found"); // hide existence
  }
  const destination = await repos.backupDestination.findById(policy.destinationId);
  if (!destination || destination.userId !== opts.userId) {
    throw new Error("Backup destination not accessible");
  }

  return backupOrchestrator.enqueue({
    policyId: opts.policyId,
    trigger: {
      source: "manual",
      userId: opts.userId,
      clientIp: opts.clientIp,
    },
  });
}
