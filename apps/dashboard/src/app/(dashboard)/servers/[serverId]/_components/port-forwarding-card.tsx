"use client";

/**
 * Port Forwarding card — Desktop-only.
 *
 * VS Code-style port forwarding: expose a remote server port as
 * `localhost:<port>` on the user's machine. Rendered in the server detail
 * "Ports" tab ONLY when `deployMode === "desktop"` (the parent gates it); the
 * backend independently gates the routes with `assertDesktop`, so this is UI
 * convenience, not the security boundary.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Network,
  Plus,
  Play,
  Square,
  Trash2,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { getApiErrorMessage, systemApi } from "@/lib/api";
import type { TunnelInfo } from "@/lib/api/system";
import { useToast } from "@/context/ToastContext";
import { Switch } from "@/components/ui/Switch";

const POLL_MS = 4000;

export function PortForwardingCard({ serverId }: { serverId: string }) {
  const { showToast } = useToast();
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  /** Per-tunnel in-flight action, keyed by tunnel id. */
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  // Add form
  const [remotePort, setRemotePort] = useState("");
  const [localPort, setLocalPort] = useState("");
  const [autoStart, setAutoStart] = useState(false);
  const [adding, setAdding] = useState(false);

  // Avoid setState after unmount during polling.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!serverId) return;
      if (!opts.silent) setLoading(true);
      try {
        const rows = await systemApi.listTunnels(serverId);
        if (mounted.current) setTunnels(rows);
      } catch {
        // Silent on poll; the card just keeps its last good state.
      } finally {
        if (mounted.current && !opts.silent) setLoading(false);
      }
    },
    [serverId],
  );

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh({ silent: true }), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const withBusy = useCallback(
    async (id: string, fn: () => Promise<void>) => {
      setBusy((b) => ({ ...b, [id]: true }));
      try {
        await fn();
      } finally {
        if (mounted.current) setBusy((b) => ({ ...b, [id]: false }));
      }
    },
    [],
  );

  const handleAdd = useCallback(async () => {
    const rp = Number(remotePort);
    if (!Number.isInteger(rp) || rp < 1 || rp > 65535) {
      showToast("Remote port must be between 1 and 65535", "error", "Port Forwarding");
      return;
    }
    const lpRaw = localPort.trim();
    let lp: number | null = null;
    if (lpRaw) {
      const n = Number(lpRaw);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        showToast("Local port must be 0 (auto) or 1–65535", "error", "Port Forwarding");
        return;
      }
      lp = n;
    }
    setAdding(true);
    try {
      await systemApi.saveTunnel(serverId, {
        remotePort: rp,
        localPort: lp,
        autoStart,
      });
      setRemotePort("");
      setLocalPort("");
      setAutoStart(false);
      await refresh({ silent: true });
    } catch (err) {
      showToast(getApiErrorMessage(err), "error", "Port Forwarding");
    } finally {
      if (mounted.current) setAdding(false);
    }
  }, [remotePort, localPort, autoStart, serverId, refresh, showToast]);

  const handleStart = useCallback(
    (t: TunnelInfo) =>
      withBusy(t.id, async () => {
        try {
          await systemApi.startTunnel(serverId, t.id);
          await refresh({ silent: true });
        } catch (err) {
          showToast(getApiErrorMessage(err), "error", "Port Forwarding");
        }
      }),
    [serverId, refresh, showToast, withBusy],
  );

  const handleStop = useCallback(
    (t: TunnelInfo) =>
      withBusy(t.id, async () => {
        try {
          await systemApi.stopTunnel(serverId, t.id);
          await refresh({ silent: true });
        } catch (err) {
          showToast(getApiErrorMessage(err), "error", "Port Forwarding");
        }
      }),
    [serverId, refresh, showToast, withBusy],
  );

  const handleToggleAutostart = useCallback(
    (t: TunnelInfo) =>
      withBusy(t.id, async () => {
        try {
          await systemApi.saveTunnel(serverId, {
            remotePort: t.remotePort,
            remoteHost: t.remoteHost,
            localPort: t.localPort,
            autoStart: !t.autoStart,
          });
          await refresh({ silent: true });
        } catch (err) {
          showToast(getApiErrorMessage(err), "error", "Port Forwarding");
        }
      }),
    [serverId, refresh, showToast, withBusy],
  );

  const handleDelete = useCallback(
    (t: TunnelInfo) =>
      withBusy(t.id, async () => {
        try {
          await systemApi.deleteTunnel(serverId, t.id);
          await refresh({ silent: true });
        } catch (err) {
          showToast(getApiErrorMessage(err), "error", "Port Forwarding");
        }
      }),
    [serverId, refresh, showToast, withBusy],
  );

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="flex items-center gap-2 mb-1">
        <Network className="size-4 text-muted-foreground" />
        <h3 className="font-semibold text-foreground text-sm">Port Forwarding</h3>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground mb-4">
        Like VS Code: reach a remote server port at{" "}
        <span className="font-mono text-foreground/80">localhost</span> on this
        machine. Bound to loopback only, and active only while forwarded.
      </p>

      {/* Tunnel list */}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
          <Loader2 className="size-4 animate-spin" />
          Loading…
        </div>
      ) : tunnels.length === 0 ? (
        <div className="text-sm text-muted-foreground py-3">
          No forwards yet.
        </div>
      ) : (
        <ul className="space-y-2 mb-4">
          {tunnels.map((t) => {
            const isBusy = !!busy[t.id];
            return (
              <li
                key={t.id}
                className="rounded-xl border border-border/60 bg-muted/30 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={`size-2 rounded-full shrink-0 ${
                          t.running ? "bg-emerald-500" : "bg-muted-foreground/40"
                        }`}
                        title={t.running ? "Running" : "Stopped"}
                      />
                      <span className="text-sm font-mono text-foreground truncate">
                        {t.remoteHost}:{t.remotePort}
                      </span>
                    </div>
                    <div className="mt-1 pl-4 text-xs text-muted-foreground">
                      {t.running && t.url ? (
                        <a
                          href={t.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-primary hover:underline font-mono"
                        >
                          {t.url.replace(/^https?:\/\//, "")}
                          <ExternalLink className="size-3" />
                        </a>
                      ) : (
                        <span className="font-mono">
                          localhost:{t.localPort ?? t.remotePort}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    {t.running ? (
                      <button
                        onClick={() => void handleStop(t)}
                        disabled={isBusy}
                        title="Stop"
                        className="w-7 h-7 rounded-lg hover:bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors"
                      >
                        {isBusy ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Square className="size-3.5" />
                        )}
                      </button>
                    ) : (
                      <button
                        onClick={() => void handleStart(t)}
                        disabled={isBusy}
                        title="Start"
                        className="w-7 h-7 rounded-lg hover:bg-muted flex items-center justify-center text-muted-foreground hover:text-emerald-600 disabled:opacity-50 transition-colors"
                      >
                        {isBusy ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Play className="size-3.5" />
                        )}
                      </button>
                    )}
                    <button
                      onClick={() => void handleDelete(t)}
                      disabled={isBusy}
                      title="Remove"
                      className="w-7 h-7 rounded-lg hover:bg-red-500/10 flex items-center justify-center text-muted-foreground hover:text-red-600 disabled:opacity-50 transition-colors"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>

                <div className="mt-2.5 flex items-center justify-between border-t border-border/40 pt-2">
                  <span className="text-xs text-muted-foreground">Open on startup</span>
                  <Switch
                    size="sm"
                    checked={t.autoStart}
                    disabled={isBusy}
                    onChange={() => void handleToggleAutostart(t)}
                    ariaLabel="Open this forward on startup"
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Add form */}
      <div className="border-t border-border/60 pt-3 space-y-2">
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={65535}
            value={remotePort}
            onChange={(e) => setRemotePort(e.target.value)}
            placeholder="Remote port"
            className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            type="number"
            min={0}
            max={65535}
            value={localPort}
            onChange={(e) => setLocalPort(e.target.value)}
            placeholder="Local (auto)"
            className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-muted-foreground select-none">
            <Switch
              size="sm"
              checked={autoStart}
              onChange={setAutoStart}
              ariaLabel="Open new forward on startup"
            />
            Open on startup
          </div>
          <button
            onClick={() => void handleAdd()}
            disabled={adding || !remotePort}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {adding ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Plus className="size-3.5" />
            )}
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
