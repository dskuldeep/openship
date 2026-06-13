/**
 * In-process JobRunner — no external dependencies.
 *
 * Backup runs are persistent via the `backup_run` table: a row with
 * status='queued' IS a pending job. The runner has two parts:
 *
 *   1. A `setImmediate` fast-path that fires processRun on
 *      enqueueRun() — keeps "Backup now" feeling instant.
 *   2. A 30-second polling loop that picks up any queued rows the
 *      fast-path missed (process crashed between row-create and
 *      processRun call, or a different node inserted it). This makes
 *      the runner correct across restarts WITHOUT needing Redis.
 *
 * Recurring jobs are in-memory cron-parser-driven setTimeout chains.
 * On process restart they're re-registered from the DB by the cron
 * trigger module's `reconcileAllSchedules`, so nothing is lost
 * persistently — the schedule lives in backup_policy.cron_expression.
 *
 * Concurrency: a simple semaphore caps concurrent processRun calls
 * (default 2 — same as the BullMQ runner). Beyond that, jobs sit in
 * the queue until a slot opens.
 */

import cronParser from "cron-parser";
import { repos } from "@repo/db";
import type { JobRunner } from "./types";

const POLL_INTERVAL_MS = 30_000;
const DEFAULT_CONCURRENCY = 2;

interface RecurringSchedule {
  jobId: string;
  cronExpression: string;
  onTick: () => Promise<void>;
  timer: NodeJS.Timeout | null;
}

export class InProcessJobRunner implements JobRunner {
  readonly name = "in-process" as const;

  private processRun: ((runId: string) => Promise<void>) | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly recurring = new Map<string, RecurringSchedule>();
  private readonly inFlight = new Set<string>();
  private readonly enqueueQueue: string[] = [];
  private readonly maxConcurrency = DEFAULT_CONCURRENCY;
  private shuttingDown = false;
  private started = false;

  async start(opts: { processRun: (runId: string) => Promise<void> }): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.processRun = opts.processRun;

    // Sweep any queued runs left over from a previous boot (BullMQ would
    // pick these up automatically; here we have to scan + enqueue).
    await this.requeueOrphanedRuns();

    // Poll periodically — backstop for runs the fast-path missed.
    this.pollTimer = setInterval(() => {
      void this.poll().catch((err) =>
        console.warn("[job-runner:in-process] poll error:", err),
      );
    }, POLL_INTERVAL_MS);
    this.pollTimer.unref();
  }

  async shutdown(deadlineMs = 30_000): Promise<void> {
    this.shuttingDown = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    // Stop every recurring timer.
    for (const r of this.recurring.values()) {
      if (r.timer) clearTimeout(r.timer);
      r.timer = null;
    }
    // Wait for in-flight jobs to finish or the deadline.
    const start = Date.now();
    while (this.inFlight.size > 0 && Date.now() - start < deadlineMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.inFlight.size > 0) {
      console.warn(
        `[job-runner:in-process] shutdown deadline passed with ${this.inFlight.size} in-flight jobs`,
      );
    }
    this.started = false;
  }

  async enqueueRun(runId: string): Promise<void> {
    if (this.shuttingDown) return;
    // Fast path — fire as soon as the event loop yields. The persistent
    // row in backup_run guarantees crash-safety; the next poll picks it
    // up if we crash before fire.
    this.enqueueQueue.push(runId);
    setImmediate(() => void this.drainQueue());
  }

  async scheduleRecurring(opts: {
    jobId: string;
    cronExpression: string;
    onTick: () => Promise<void>;
  }): Promise<void> {
    // Replace any existing schedule with the same id.
    await this.removeRecurring(opts.jobId);

    const entry: RecurringSchedule = {
      jobId: opts.jobId,
      cronExpression: opts.cronExpression,
      onTick: opts.onTick,
      timer: null,
    };
    this.recurring.set(opts.jobId, entry);
    this.armNextTick(entry);
  }

  async removeRecurring(jobId: string): Promise<void> {
    const existing = this.recurring.get(jobId);
    if (!existing) return;
    if (existing.timer) clearTimeout(existing.timer);
    this.recurring.delete(jobId);
  }

  describe(): string {
    return `in-process (no Redis required)`;
  }

  // ── Internals ───────────────────────────────────────────────────────

  /** Arm a setTimeout chain that fires the cron expression's next tick,
   *  then re-arms itself for the tick after that. */
  private armNextTick(entry: RecurringSchedule): void {
    if (this.shuttingDown) return;
    let nextMs: number;
    try {
      const interval = cronParser.parseExpression(entry.cronExpression);
      nextMs = Math.max(0, interval.next().getTime() - Date.now());
    } catch (err) {
      console.warn(
        `[job-runner:in-process] invalid cron "${entry.cronExpression}" for ${entry.jobId} — schedule disabled`,
      );
      this.recurring.delete(entry.jobId);
      return;
    }

    entry.timer = setTimeout(async () => {
      // Re-check we're still registered + not shutting down — caller
      // may have removed us during the wait.
      if (this.shuttingDown || !this.recurring.has(entry.jobId)) return;
      try {
        await entry.onTick();
      } catch (err) {
        console.warn(
          `[job-runner:in-process] recurring ${entry.jobId} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
      // Arm the next tick.
      this.armNextTick(entry);
    }, nextMs);
    entry.timer.unref();
  }

  private async drainQueue(): Promise<void> {
    if (this.shuttingDown || !this.processRun) return;
    while (
      this.enqueueQueue.length > 0 &&
      this.inFlight.size < this.maxConcurrency
    ) {
      const runId = this.enqueueQueue.shift();
      if (!runId) break;
      if (this.inFlight.has(runId)) continue; // dedupe
      this.inFlight.add(runId);
      void this.processRun(runId)
        .catch((err) =>
          console.error(
            `[job-runner:in-process] run ${runId} crashed:`,
            err instanceof Error ? err.message : err,
          ),
        )
        .finally(() => {
          this.inFlight.delete(runId);
          // Try to claim more — there may be queued items waiting.
          if (this.enqueueQueue.length > 0) {
            setImmediate(() => void this.drainQueue());
          }
        });
    }
  }

  private async poll(): Promise<void> {
    if (this.shuttingDown) return;
    // Pull queued runs that nobody's claimed yet. Limit pulled per cycle
    // so we don't blow concurrency in one shot — drainQueue handles
    // throttling.
    try {
      const queued = await repos.backupRun.listQueued(20);
      for (const run of queued) {
        if (!this.inFlight.has(run.id) && !this.enqueueQueue.includes(run.id)) {
          this.enqueueQueue.push(run.id);
        }
      }
      if (this.enqueueQueue.length > 0) void this.drainQueue();
    } catch (err) {
      console.warn(
        "[job-runner:in-process] poll query failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** Boot-time: re-queue any runs that were left in 'queued' state by
   *  a previous process. Strictly we could just rely on the poller, but
   *  doing this explicitly at startup makes the first-tick latency
   *  zero instead of up to POLL_INTERVAL_MS. */
  private async requeueOrphanedRuns(): Promise<void> {
    try {
      const queued = await repos.backupRun.listQueued(100);
      for (const run of queued) {
        this.enqueueQueue.push(run.id);
      }
      if (this.enqueueQueue.length > 0) void this.drainQueue();
    } catch (err) {
      console.warn(
        "[job-runner:in-process] boot requeue failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }
}
