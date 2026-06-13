/**
 * Restore-run SSE channel. Mirrors backup.sse.ts shape.
 */

import { EventEmitter } from "node:events";
import type { BackupRestore, BackupRestoreStatus } from "@repo/db";

export type RestoreRunEvent =
  | {
      type: "transition";
      status: BackupRestoreStatus;
      bytesRestored?: number | null;
    }
  | {
      type: "snapshot";
      restore: BackupRestore;
    }
  | {
      type: "complete";
      status: "succeeded" | "failed" | "cancelled" | "server_error";
      errorMessage?: string | null;
    };

const TERMINAL: ReadonlySet<BackupRestoreStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "server_error",
]);

class RestoreRunBus extends EventEmitter {
  publish(restoreId: string, event: RestoreRunEvent): void {
    this.emit(restoreId, event);
    if (
      event.type === "complete" ||
      (event.type === "transition" && TERMINAL.has(event.status))
    ) {
      setImmediate(() => this.removeAllListeners(restoreId));
    }
  }

  subscribe(restoreId: string, listener: (e: RestoreRunEvent) => void): () => void {
    this.on(restoreId, listener);
    return () => this.off(restoreId, listener);
  }
}

export const restoreRunBus = new RestoreRunBus();
restoreRunBus.setMaxListeners(32);
