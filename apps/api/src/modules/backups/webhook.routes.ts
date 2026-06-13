/**
 * Inbound backup webhooks.
 *
 * Separate route file because there's NO auth middleware — the token
 * in the URL is the credential. Rate-limited via the existing
 * rateLimiter middleware so a leaked token can't be used as a
 * "trigger a backup every 5ms" amplification.
 *
 * Two endpoints:
 *   POST /api/webhooks/backup          — preferred. Token in
 *     `Authorization: Bearer <token>` header. Tokens never appear in
 *     access logs, referrer chains, proxy logs, or shell history.
 *   POST /api/webhooks/backup/:token   — legacy. Token in URL path.
 *     Kept for any monitor / CI that already has the URL hard-coded;
 *     the dashboard surfaces a deprecation hint when the policy was
 *     last fired via this shape. Plan to remove in a later release.
 *
 * Mounted at `/api/webhooks/backup` from app.ts.
 */

import { Hono, type Context } from "hono";
import { rateLimiter } from "../../middleware/rate-limiter";
import { triggerBackupViaWebhook } from "./triggers/webhook";

export const backupWebhookRoutes = new Hono();

backupWebhookRoutes.use("*", rateLimiter);

function extractClientContext(c: Context): {
  clientIp: string | undefined;
  userAgent: string | undefined;
} {
  const clientIp =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    undefined;
  const userAgent = c.req.header("user-agent") ?? undefined;
  return { clientIp, userAgent };
}

/** Preferred shape: token in the Authorization header. */
backupWebhookRoutes.post("/", async (c) => {
  const authHeader = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match) {
    return c.json({ error: "Not found" }, 404);
  }
  const token = match[1]?.trim();
  if (!token) return c.json({ error: "Not found" }, 404);

  const { clientIp, userAgent } = extractClientContext(c);
  const result = await triggerBackupViaWebhook({ token, clientIp, userAgent });

  if ("error" in result) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({ data: { runId: result.runId } });
});

/**
 * Legacy: token in URL path. Still works, but discouraged — the URL
 * (and therefore the token) tends to leak into nginx access logs,
 * Cloudflare event streams, and CI run histories. New integrations
 * should use the header shape above. The token DB write records a
 * `usedLegacyUrl` boolean (Chunk 4 dashboard) to nudge migration.
 */
backupWebhookRoutes.post("/:token", async (c) => {
  const token = c.req.param("token");
  if (!token) return c.json({ error: "Token required" }, 400);

  const { clientIp, userAgent } = extractClientContext(c);
  const result = await triggerBackupViaWebhook({ token, clientIp, userAgent });

  if ("error" in result) {
    // 404 for both "no such token" and "disabled" — don't leak
    // existence vs. disabled-ness to a probe.
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({ data: { runId: result.runId } });
});
