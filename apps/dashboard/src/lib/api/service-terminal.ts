/**
 * Service terminal API client. Sibling of lib/api/terminal.ts
 * (server-level). Same wire protocol — only the ticket endpoint and
 * the WS URL change.
 *
 * Flow:
 *   1. Browser cannot set Authorization headers on WebSocket(), so
 *      we authenticate via a single-use ticket carried in
 *      Sec-WebSocket-Protocol.
 *   2. Dashboard hits POST /api/services/terminal/ticket with the
 *      Better Auth cookie, gets the opaque token.
 *   3. Dashboard opens `new WebSocket(url, ["openship.terminal.v1+<token>"])`.
 *      The server consumes the token before the channel opens —
 *      single-use, ~30s TTL, bound to (userId, serviceId).
 */

import { api, getApiBaseUrl } from "./client";
import { endpoints } from "./endpoints";

// IMPORTANT: protocol prefixes are SHARED with the server terminal so
// the dashboard's hook + xterm wire layer is symmetric. The server-
// side controllers parse identical prefixes.
import {
  TERMINAL_SUBPROTOCOL_PREFIX,
  TERMINAL_RESUME_SUBPROTOCOL_PREFIX,
  type TerminalTicketResponse,
} from "./terminal";

export {
  TERMINAL_SUBPROTOCOL_PREFIX,
  TERMINAL_RESUME_SUBPROTOCOL_PREFIX,
};

export async function requestServiceTerminalTicket(
  serviceId: string,
): Promise<TerminalTicketResponse> {
  return api.post<TerminalTicketResponse>(endpoints.serviceTerminal.ticket, {
    serviceId,
  });
}

export function buildServiceTerminalWsUrl(serviceId: string): string {
  const base = getApiBaseUrl();
  const url = new URL(endpoints.serviceTerminal.wsPath(serviceId), base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
