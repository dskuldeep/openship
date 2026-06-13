/**
 * Interactive SERVICE terminal controller.
 *
 * Sibling of modules/terminal/terminal.controller.ts (which exposes
 * server-level SSH shells). The wire protocol — subprotocol-token
 * auth, binary PTY frames, JSON resize/ping/exit/close — is identical,
 * so the dashboard's xterm + usePtyConnection layers are nearly
 * symmetric across both endpoints.
 *
 * The only thing that differs is the resolution step:
 *   - server terminal:  sshManager.openShell() against `servers.id`
 *   - service terminal: runtime.openServiceShell() against the
 *                        deployed container/workspace id, where the
 *                        runtime is selected per-service from the
 *                        owning deployment's meta (Docker vs Cloud).
 *
 * Two endpoints:
 *   POST /api/services/:serviceId/terminal/ticket → mint a WS ticket
 *   GET  /api/services/:serviceId/terminal/ws     → WS upgrade
 *
 * Subprotocol prefix: "openship.terminal.v1+" (shared with server
 * terminal — the prefix isn't resource-scoped). Resume subprotocol
 * prefix: "openship.terminal.resume+" (same).
 */

import type { Context } from "hono";
import { auth } from "../../lib/auth";
import { trustedOrigins } from "../../config/env";
import { upgradeWebSocket } from "../../lib/ws";
import { repos } from "@repo/db";
import type { ShellSession } from "@repo/adapters";
import type { TerminalExitReason } from "@repo/db";
import { resolveDeploymentRuntime } from "../../lib/deployment-runtime";
import { safeErrorMessage } from "../../lib/safe-error";
import {
  attachServiceWs,
  consumeServiceTerminalTicket,
  countActiveServiceSessionsByUser,
  dispatchServiceStdout,
  getServiceSessionByResumeToken,
  issueServiceTerminalTicket,
  maxServiceSessionsPerUser,
  parkServiceSession,
  registerServiceSession,
  touchServiceSession,
  unregisterServiceSession,
} from "../../lib/service-terminal-session-manager";

// ─── Constants ──────────────────────────────────────────────────────────────

const SUBPROTOCOL_PREFIX = "openship.terminal.v1+";
const RESUME_SUBPROTOCOL_PREFIX = "openship.terminal.resume+";
const HEARTBEAT_INTERVAL_MS = 25_000;
const COLS_MIN = 1, COLS_MAX = 1000;
const ROWS_MIN = 1, ROWS_MAX = 500;

// ─── Helpers ────────────────────────────────────────────────────────────────

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return trustedOrigins.includes(origin);
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

interface ControlIn {
  type: "resize" | "ping" | "close";
  cols?: number;
  rows?: number;
}
type ControlOut =
  | { type: "ready"; sessionId: string; resumeToken: string; resumed: boolean }
  | { type: "exit"; code: number | null; signal?: string }
  | { type: "error"; code: ErrorCode; message: string }
  | { type: "pong" };

type ErrorCode =
  | "ssh_auth" // reused for "auth failed at upgrade"
  | "ssh_connect" // reused for "runtime open failed"
  | "server_not_found" // reused for "service not found"
  | "max_sessions"
  | "idle_timeout"
  | "session_cap"
  | "resume_failed"
  | "server_error"
  | "not_supported" // runtime lacks serviceShell capability
  | "not_deployed"; // service has no running container yet

// ─── Service ownership + resolution ─────────────────────────────────────────

/**
 * Look up the service, verify the caller owns the parent project, and
 * resolve the runtime + containerId. Returns null on any failure with
 * a structured reason — controller decides which close code to emit.
 */
async function resolveServiceForUser(
  serviceId: string,
  userId: string,
): Promise<
  | { ok: true; containerId: string; runtime: import("@repo/adapters").RuntimeAdapter }
  | { ok: false; code: ErrorCode; message: string }
> {
  const service = await repos.service.findById(serviceId);
  if (!service) return { ok: false, code: "server_not_found", message: "Service not found" };

  const project = await repos.project.findById(service.projectId);
  if (!project || project.userId !== userId) {
    // Same 404-shape as backup endpoints: don't leak existence vs.
    // authorization.
    return { ok: false, code: "server_not_found", message: "Service not found" };
  }

  if (!project.activeDeploymentId) {
    return {
      ok: false,
      code: "not_deployed",
      message: "Project has no active deployment yet",
    };
  }
  const dep = await repos.deployment.findById(project.activeDeploymentId);
  if (!dep) {
    return {
      ok: false,
      code: "not_deployed",
      message: "Active deployment not found",
    };
  }

  // Resolve the runtime that built/owns this deployment (Docker vs Cloud).
  let runtime: import("@repo/adapters").RuntimeAdapter;
  try {
    const resolved = await resolveDeploymentRuntime({
      meta: dep.meta,
      userId: project.userId,
    });
    runtime = resolved.runtime;
  } catch (err) {
    return {
      ok: false,
      code: "server_error",
      message: `Failed to resolve runtime: ${safeErrorMessage(err)}`,
    };
  }

  if (!runtime.supports("serviceShell") || !runtime.openServiceShell) {
    return {
      ok: false,
      code: "not_supported",
      message: `Terminal not supported on ${runtime.name} runtime`,
    };
  }

  // Resolve the actual container/workspace id for this service. Compose
  // deploys stash per-service ids in deployment.meta.composeServices.
  const meta = (dep.meta ?? {}) as {
    composeServices?: Array<{ name: string; containerId?: string }>;
  };
  const entry = meta.composeServices?.find((s) => s.name === service.name);
  const containerId = entry?.containerId ?? dep.containerId;
  if (!containerId) {
    return {
      ok: false,
      code: "not_deployed",
      message: "Service has not finished deploying yet",
    };
  }

  return { ok: true, containerId, runtime };
}

// ─── Ticket endpoint ────────────────────────────────────────────────────────

export async function issueTicket(c: Context) {
  const user = c.get("user") as { id: string } | undefined;
  if (!user?.id) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const serviceId = typeof (body as { serviceId?: unknown }).serviceId === "string"
    ? ((body as { serviceId: string }).serviceId)
    : "";
  if (!serviceId) return c.json({ error: "serviceId required" }, 400);

  // Surface 404 here so the dashboard can show a clear error without
  // burning an upgrade attempt. We deliberately do NOT precheck the
  // runtime / containerId at ticket time — those checks belong to the
  // WS open path, which can communicate a structured error frame.
  const result = await resolveServiceForUser(serviceId, user.id);
  if (!result.ok && (result.code === "server_not_found" || result.code === "not_deployed")) {
    return c.json({ error: result.message }, 404);
  }

  const { token, expiresIn } = issueServiceTerminalTicket(user.id, serviceId);
  return c.json({ success: true, token, expiresIn });
}

// ─── WebSocket upgrade ──────────────────────────────────────────────────────

export const serviceTerminalWsHandler = upgradeWebSocket(async (c) => {
  // 1. Origin allowlist
  const origin = c.req.header("origin") ?? null;
  if (!isAllowedOrigin(origin)) {
    return openInitFailure("server_error", "Origin not allowed", 4403);
  }

  // 2. Subprotocol-based ticket auth (with cookie fallback).
  const protocols = (c.req.header("sec-websocket-protocol") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const tokenProto = protocols.find((p) => p.startsWith(SUBPROTOCOL_PREFIX));
  const token = tokenProto ? tokenProto.slice(SUBPROTOCOL_PREFIX.length) : "";
  const ticket = token ? consumeServiceTerminalTicket(token) : null;

  const resumeProto = protocols.find((p) =>
    p.startsWith(RESUME_SUBPROTOCOL_PREFIX),
  );
  const resumeToken = resumeProto
    ? resumeProto.slice(RESUME_SUBPROTOCOL_PREFIX.length)
    : "";

  let userId: string | null = null;
  let ticketServiceId: string | null = null;
  if (ticket) {
    userId = ticket.userId;
    ticketServiceId = ticket.serviceId;
  } else {
    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (session?.user?.id) userId = session.user.id;
    } catch {
      /* fall through */
    }
  }
  if (!userId) return openInitFailure("ssh_auth", "Unauthorized", 4401);

  // 3. Service existence + path binding
  const pathServiceId = c.req.param("serviceId");
  if (!pathServiceId)
    return openInitFailure("server_not_found", "serviceId required", 4400);
  if (ticketServiceId && ticketServiceId !== pathServiceId) {
    return openInitFailure("ssh_auth", "Ticket / path mismatch", 4401);
  }

  // Resolve runtime + containerId. This validates ownership too —
  // resolveServiceForUser refuses if the caller doesn't own the
  // service's project.
  const resolved = await resolveServiceForUser(pathServiceId, userId);
  if (!resolved.ok) {
    const closeCode =
      resolved.code === "server_not_found"
        ? 4404
        : resolved.code === "not_deployed"
          ? 4404
          : resolved.code === "not_supported"
            ? 4400
            : 4500;
    return openInitFailure(resolved.code, resolved.message, closeCode);
  }

  // 4. Per-user concurrent cap (skip on resume).
  if (!resumeToken) {
    const inMem = countActiveServiceSessionsByUser(userId);
    if (inMem >= maxServiceSessionsPerUser()) {
      return openInitFailure("max_sessions", "Too many active sessions", 4429);
    }
    const dbCount = await repos.serviceTerminalSession.countActiveByUser(userId);
    if (dbCount >= maxServiceSessionsPerUser()) {
      return openInitFailure("max_sessions", "Too many active sessions", 4429);
    }
  }

  const clientIp =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    null;
  const userAgent = c.req.header("user-agent") ?? null;

  const ctx: HandshakeCtx = {
    userId,
    serviceId: pathServiceId,
    containerId: resolved.containerId,
    runtime: resolved.runtime,
    clientIp,
    userAgent,
    subprotocol: tokenProto,
    resumeToken,
  };

  return buildHandlers(ctx);
});

// ─── Per-connection state ───────────────────────────────────────────────────

interface HandshakeCtx {
  userId: string;
  serviceId: string;
  containerId: string;
  runtime: import("@repo/adapters").RuntimeAdapter;
  clientIp: string | null;
  userAgent: string | null;
  subprotocol: string | undefined;
  resumeToken: string;
}

interface ConnState {
  ctx: HandshakeCtx;
  sessionId: string | null;
  shell: ShellSession | null;
  ws: WSLike | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  closed: boolean;
  userTerminated: boolean;
}

interface WSLike {
  send(data: string | ArrayBufferLike | Uint8Array): void;
  close(code?: number, reason?: string): void;
  readyState?: number;
}

function buildHandlers(ctx: HandshakeCtx) {
  const state: ConnState = {
    ctx,
    sessionId: null,
    shell: null,
    ws: null,
    heartbeatTimer: null,
    closed: false,
    userTerminated: false,
  };

  return {
    async onOpen(_evt: unknown, ws: WSLike) {
      state.ws = ws;
      const dataPump = (chunk: Buffer) => {
        if (state.closed) return;
        try {
          ws.send(chunk);
        } catch {
          /* peer gone */
        }
      };

      // RESUME path
      if (ctx.resumeToken) {
        const existing = getServiceSessionByResumeToken(
          ctx.resumeToken,
          ctx.userId,
        );
        if (!existing) {
          sendControl(ws, {
            type: "error",
            code: "resume_failed",
            message: "Session is no longer available",
          });
          try {
            ws.close(1011, "resume_failed");
          } catch {
            /* already closing */
          }
          return;
        }

        state.shell = existing.shell;
        state.sessionId = existing.sessionId;
        attachServiceWs(existing.sessionId, dataPump);

        existing.shell.onClose((code: number | null, signal?: string) => {
          sendControl(ws, { type: "exit", code, signal });
          try {
            ws.close(1000, "remote_exit");
          } catch {
            /* already closing */
          }
          void teardown(state, "remote_exit", code);
        });

        state.heartbeatTimer = setInterval(() => {
          sendControl(ws, { type: "pong" });
        }, HEARTBEAT_INTERVAL_MS);
        (state.heartbeatTimer as { unref?: () => void }).unref?.();

        sendControl(ws, {
          type: "ready",
          sessionId: existing.sessionId,
          resumeToken: existing.resumeToken,
          resumed: true,
        });
        return;
      }

      // FRESH path
      let shell: ShellSession;
      let auditId: string | null = null;
      try {
        if (!ctx.runtime.openServiceShell) {
          throw new Error("Runtime does not implement openServiceShell");
        }
        shell = await ctx.runtime.openServiceShell(ctx.containerId, {
          cols: 80,
          rows: 24,
          term: "xterm-256color",
        });
      } catch (err) {
        const code: ErrorCode = "ssh_connect";
        sendControl(ws, {
          type: "error",
          code,
          message: safeErrorMessage(err),
        });
        try {
          ws.close(1011, code);
        } catch {
          /* already closing */
        }
        return;
      }

      state.shell = shell;

      try {
        const row = await repos.serviceTerminalSession.open({
          userId: ctx.userId,
          serviceId: ctx.serviceId,
          clientIp: ctx.clientIp,
          userAgent: ctx.userAgent,
        });
        auditId = row.id;
      } catch {
        // eslint-disable-next-line no-console
        console.error("[service-terminal] failed to write audit open row");
      }

      const sessionId = auditId ?? `transient-${Date.now()}`;
      const session = registerServiceSession({
        sessionId,
        userId: ctx.userId,
        serviceId: ctx.serviceId,
        shell,
        onTimeout: (_sid, reason) => {
          sendControl(ws, {
            type: "error",
            code: reason as ErrorCode,
            message: reason,
          });
          try {
            ws.close(1011, reason);
          } catch {
            /* already closing */
          }
          void teardown(state, reason, null, true, true);
        },
      });
      state.sessionId = sessionId;

      attachServiceWs(sessionId, dataPump);
      shell.stdout.on("data", (chunk: Buffer) =>
        dispatchServiceStdout(sessionId, chunk),
      );
      shell.stderr.on("data", (chunk: Buffer) =>
        dispatchServiceStdout(sessionId, chunk),
      );

      shell.onClose((code: number | null, signal?: string) => {
        sendControl(ws, { type: "exit", code, signal });
        try {
          ws.close(1000, "remote_exit");
        } catch {
          /* already closing */
        }
        void teardown(state, "remote_exit", code, false, true);
      });

      state.heartbeatTimer = setInterval(() => {
        sendControl(ws, { type: "pong" });
      }, HEARTBEAT_INTERVAL_MS);
      (state.heartbeatTimer as { unref?: () => void }).unref?.();

      sendControl(ws, {
        type: "ready",
        sessionId,
        resumeToken: session.resumeToken,
        resumed: false,
      });
    },

    onMessage(evt: { data: unknown }, ws: WSLike) {
      if (state.closed || !state.shell) return;

      const data = evt.data;
      if (data instanceof ArrayBuffer) {
        if (state.sessionId) touchServiceSession(state.sessionId);
        try {
          state.shell.stdin.write(Buffer.from(data));
        } catch {
          /* shell gone */
        }
        return;
      }
      if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
        if (state.sessionId) touchServiceSession(state.sessionId);
        try {
          state.shell.stdin.write(Buffer.from(data as Uint8Array));
        } catch {
          /* shell gone */
        }
        return;
      }
      if (typeof data === "string") {
        let msg: ControlIn;
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
        if (msg?.type === "resize") {
          const cols = clamp(Number(msg.cols), COLS_MIN, COLS_MAX);
          const rows = clamp(Number(msg.rows), ROWS_MIN, ROWS_MAX);
          state.shell.setWindow(cols, rows);
          return;
        }
        if (msg?.type === "ping") {
          if (state.sessionId) touchServiceSession(state.sessionId);
          sendControl(ws, { type: "pong" });
          return;
        }
        if (msg?.type === "close") {
          state.userTerminated = true;
          try {
            ws.close(1000, "client_terminate");
          } catch {
            /* already closing */
          }
          return;
        }
      }
    },

    onClose() {
      void teardown(
        state,
        "client_close",
        null,
        false,
        state.userTerminated,
      );
    },

    onError() {
      void teardown(state, "client_close", null, false, false);
    },
  };
}

async function teardown(
  state: ConnState,
  reason: TerminalExitReason,
  exitCode: number | null,
  alreadyUnregistered = false,
  forceClose = true,
) {
  if (state.closed) return;
  state.closed = true;

  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }

  if (!forceClose && state.sessionId) {
    parkServiceSession(state.sessionId);
    return;
  }

  if (state.shell) {
    try {
      state.shell.close();
    } catch {
      /* best-effort */
    }
    state.shell = null;
  }

  if (!alreadyUnregistered && state.sessionId) {
    unregisterServiceSession(state.sessionId);
  }

  if (state.sessionId && !state.sessionId.startsWith("transient-")) {
    try {
      await repos.serviceTerminalSession.close(state.sessionId, {
        exitCode,
        exitReason: reason,
      });
    } catch {
      // boot-time sweep will close orphaned rows
    }
  }
}

function sendControl(ws: WSLike, msg: ControlOut): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* peer gone */
  }
}

function openInitFailure(code: ErrorCode, message: string, closeCode: number) {
  return {
    onOpen(_evt: unknown, ws: WSLike) {
      sendControl(ws, { type: "error", code, message });
      try {
        ws.close(closeCode, code);
      } catch {
        /* already closing */
      }
    },
    onMessage() {
      /* drop */
    },
    onClose() {
      /* nothing */
    },
    onError() {
      /* nothing */
    },
  };
}
