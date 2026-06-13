/**
 * Webhook trigger — inbound URL `POST /api/webhooks/backup/:token` that
 * fires a backup for the policy bound to that token.
 *
 * Security model:
 *   - The token IS the auth — there's no Bearer / cookie auth on this
 *     route. So the token must be a high-entropy, per-policy secret.
 *     Generated with crypto.randomBytes(24).toString('base64url') —
 *     192 bits of entropy.
 *   - Tokens are rotated by the policy editor (regenerate button).
 *   - Constant-time comparison NOT needed because the DB index lookup
 *     leaks nothing — the token IS the row key; either it matches or
 *     no row comes back. No "compare partial match" branch exists.
 *   - Rate-limited at the route layer (existing rateLimiter middleware).
 *   - Failed token = 404 (not 401) so an attacker can't probe valid
 *     prefixes by error-code differential.
 *
 * Policy author owns the URL — they paste it into GitHub Actions, a
 * monitor like UptimeRobot, an external scheduler, etc.
 */

import crypto from "node:crypto";
import { repos } from "@repo/db";
import { backupOrchestrator } from "../backup.orchestrator";

export function generateWebhookToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export async function triggerBackupViaWebhook(opts: {
  token: string;
  clientIp?: string;
  userAgent?: string;
}): Promise<{ runId: string } | { error: "not_found" } | { error: "disabled" }> {
  const policy = await repos.backupPolicy.findByWebhookToken(opts.token);
  if (!policy) return { error: "not_found" };
  if (!policy.enabled) return { error: "disabled" };

  await repos.backupPolicy.markWebhookFired(policy.id);

  const result = await backupOrchestrator.enqueue({
    policyId: policy.id,
    trigger: {
      source: "webhook",
      userId: policy.createdBy ?? "system",
      clientIp: opts.clientIp,
      metadata: opts.userAgent ? { userAgent: opts.userAgent } : undefined,
    },
  });
  return result;
}
