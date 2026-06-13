/**
 * Subscribe to a backup run's live progress channel.
 *
 * The server's SSE handler sends a `snapshot` event with the full row
 * immediately on connect, then `transition` / `progress` / `complete`
 * events as the FSM advances. Survives reload because the DB row is
 * authoritative — server re-snapshots on reconnect.
 */

"use client";

import { useEffect, useRef, useState } from "react";
import { getApiBaseUrl, getAuthToken, type BackupRun } from "@/lib/api";

export type BackupRunEvent =
  | {
      type: "snapshot";
      run: BackupRun;
    }
  | {
      type: "transition";
      status: BackupRun["status"];
      bytesTransferred?: number;
      artifacts?: unknown[];
    }
  | {
      type: "progress";
      bytesTransferred: number;
      currentArtifact?: string;
    }
  | {
      type: "complete";
      status: "succeeded" | "failed" | "cancelled" | "server_error";
      errorMessage?: string | null;
    };

export interface UseBackupRunStreamResult {
  run: BackupRun | null;
  connected: boolean;
  error: Error | null;
}

export function useBackupRunStream(runId: string | null): UseBackupRunStreamResult {
  const [run, setRun] = useState<BackupRun | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!runId) return;

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    (async () => {
      try {
        const token = await getAuthToken();
        const url = `${getApiBaseUrl()}backup-runs/${runId}/stream`;
        const res = await fetch(url, {
          headers: {
            Accept: "text/event-stream",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          signal: ctrl.signal,
          credentials: "include",
        });

        if (!res.ok || !res.body) {
          throw new Error(`SSE connection failed: ${res.status}`);
        }
        setConnected(true);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!ctrl.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let nl: number;
          while ((nl = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 2);
            if (!block.trim()) continue;

            // Parse one SSE event block: "event: name\ndata: json"
            let eventName = "message";
            let dataLine = "";
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) eventName = line.slice(6).trim();
              else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
            }
            if (eventName === "ping" || !dataLine) continue;

            try {
              const ev = JSON.parse(dataLine) as BackupRunEvent;
              if (ev.type === "snapshot") {
                setRun(ev.run);
              } else if (ev.type === "transition") {
                setRun((prev) =>
                  prev
                    ? {
                        ...prev,
                        status: ev.status,
                        bytesTransferred: ev.bytesTransferred ?? prev.bytesTransferred,
                        artifacts: ev.artifacts ?? prev.artifacts,
                      }
                    : prev,
                );
              } else if (ev.type === "progress") {
                setRun((prev) =>
                  prev ? { ...prev, bytesTransferred: ev.bytesTransferred } : prev,
                );
              } else if (ev.type === "complete") {
                setRun((prev) =>
                  prev
                    ? {
                        ...prev,
                        status: ev.status,
                        errorMessage: ev.errorMessage ?? prev.errorMessage,
                      }
                    : prev,
                );
                ctrl.abort();
              }
            } catch {
              // ignore malformed events
            }
          }
        }
      } catch (err: unknown) {
        if ((err as { name?: string })?.name !== "AbortError") {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        setConnected(false);
      }
    })();

    return () => {
      ctrl.abort();
    };
  }, [runId]);

  return { run, connected, error };
}
