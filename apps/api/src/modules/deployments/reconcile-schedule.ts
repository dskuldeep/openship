/**
 * Periodic reconcile sweep.
 *
 * Deployments left `reconciling` by a connection-loss deploy are settled here
 * once their host is reachable again — the safety net for the on-load trigger
 * (a project nobody opens still gets reconciled). Runs every 10 minutes.
 */

import { repos } from "@repo/db";
import { getJobRunner } from "../../lib/job-runner";
import { reconcileDeployment } from "./reconcile.service";

const RECONCILE_JOB_ID = "deployments:reconcile";
const RECONCILE_CRON = "*/10 * * * *";

export async function runReconcileSweep(): Promise<{ finalized: number; pending: number }> {
  const deps = await repos.deployment.listByStatus("reconciling");
  let finalized = 0;
  let pending = 0;
  for (const dep of deps) {
    try {
      const outcome = await reconcileDeployment(dep.id);
      if (outcome === "finalized") finalized++;
      else pending++;
    } catch (err) {
      pending++;
      console.error(`[reconcile] ${dep.id} failed`, err);
    }
  }
  return { finalized, pending };
}

export async function scheduleReconcile(): Promise<void> {
  const runner = await getJobRunner();
  await runner.scheduleRecurring({
    jobId: RECONCILE_JOB_ID,
    cronExpression: RECONCILE_CRON,
    onTick: async () => {
      try {
        const { finalized, pending } = await runReconcileSweep();
        if (finalized > 0 || pending > 0) {
          console.log(`[reconcile] finalized ${finalized}, pending ${pending}`);
        }
      } catch (err) {
        console.error("[reconcile] sweep failed", err);
      }
    },
  });
}
