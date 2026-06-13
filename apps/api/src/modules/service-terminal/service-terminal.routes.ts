import { Hono } from "hono";
import { authMiddleware } from "../../middleware/auth";
import {
  issueTicket,
  serviceTerminalWsHandler,
} from "./service-terminal.controller";
import { repos } from "@repo/db";

/**
 * Service-level interactive terminal routes.
 *
 * Unlike the server-terminal routes, this is NOT `localOnly` —
 * service terminals work on BOTH self-hosted (Docker exec into the
 * service's container) AND openship cloud (Oblien workspace terminal).
 * The adapter selection happens inside the controller via
 * resolveDeploymentRuntime(), driven by the deployment's meta.
 *
 *   POST /api/services/terminal/ticket       one-shot WS auth ticket
 *   GET  /api/services/terminal/ws/:serviceId WebSocket upgrade
 *
 * The WS endpoint deliberately does NOT apply authMiddleware: a normal
 * middleware that returns 401 would prevent the upgrade from completing.
 * Auth happens inside the upgradeWebSocket factory (ticket subprotocol
 * OR session-cookie fallback).
 */
export const serviceTerminalRoutes = new Hono();

// Ticket endpoint — normal HTTP auth.
serviceTerminalRoutes.post("/ticket", authMiddleware, issueTicket);

// WS upgrade — auth is inside the upgrade factory.
serviceTerminalRoutes.get("/ws/:serviceId", serviceTerminalWsHandler);

// Boot-time sweep: any audit rows left open by a prior crash are
// finalized as 'server_error'. Their underlying PTY streams (Docker
// exec / Oblien WS) are dead with the process anyway.
void repos.serviceTerminalSession
  .closeAllActive("server_error")
  .then((n) => {
    if (n > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[service-terminal] swept ${n} orphan session row(s) from previous run`,
      );
    }
  })
  .catch(() => {
    /* sweep failure is non-fatal */
  });
