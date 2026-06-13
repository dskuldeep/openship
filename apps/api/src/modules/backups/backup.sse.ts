/**
 * Backup-run SSE channel — mirrors the deployment session-manager pattern.
 *
 * Each run gets a topic keyed by runId. Subscribers receive every FSM
 * transition + interim progress events; when the run reaches a terminal
 * state, all subscribers get a final event and the channel closes.
 *
 * Survives dashboard refresh:
 *   - The `backup_run` DB row is the source of truth. SSE amplifies it.
 *   - On (re)connect, the route handler first sends a `snapshot` event
 *     with the current DB row, then attaches as a live subscriber for
 *     subsequent events.
 *   - If the run already finished by the time the client reconnects,
 *     the snapshot event has terminal status and the stream closes
 *     cleanly.
 */

import { EventEmitter } from "node:events";
import type { BackupRun, BackupRunStatus } from "@repo/db";

export type BackupRunEvent =
  | {
      type: "transition";
      status: BackupRunStatus;
      bytesTransferred?: number | null;
      artifacts?: unknown[];
    }
  | {
      type: "progress";
      bytesTransferred: number;
      /** Optional per-artifact label for the bar. */
      currentArtifact?: string;
    }
  | {
      type: "snapshot";
      run: BackupRun;
    }
  | {
      type: "complete";
      status: "succeeded" | "failed" | "cancelled" | "server_error";
      errorMessage?: string | null;
    };

const TERMINAL_STATUSES: ReadonlySet<BackupRunStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "server_error",
]);

class BackupRunBus extends EventEmitter {
  /** Emit + clean up if the event is terminal. */
  publish(runId: string, event: BackupRunEvent): void {
    this.emit(runId, event);
    if (event.type === "complete" || (event.type === "transition" && TERMINAL_STATUSES.has(event.status))) {
      // Defer the close so any pending listeners flush first.
      setImmediate(() => {
        this.removeAllListeners(runId);
      });
    }
  }

  subscribe(runId: string, listener: (event: BackupRunEvent) => void): () => void {
    this.on(runId, listener);
    return () => this.off(runId, listener);
  }

  hasSubscribers(runId: string): boolean {
    return this.listenerCount(runId) > 0;
  }
}

export const backupRunBus = new BackupRunBus();
// Bump the per-channel listener cap — multiple dashboard tabs may
// subscribe to the same run.
backupRunBus.setMaxListeners(32);
