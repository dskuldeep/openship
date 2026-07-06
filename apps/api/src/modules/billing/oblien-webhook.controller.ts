/**
 * Oblien webhook receiver — POST /api/billing/oblien-webhook.
 *
 * Single entry point for events Oblien fires against our endpoint
 * (registered out-of-band via `client.webhooks.create` when the org is
 * provisioned). Three event types matter today:
 *
 *   - `credits.depleted`            → suspend the namespace immediately
 *                                     via quotaWrapper.suspendIfExhausted.
 *   - `credits.low` (80%)           → soft warning email so the org can
 *                                     top up before they hit the cap.
 *   - `namespace.quota.threshold`   → same warning surface; Oblien's
 *                                     generic threshold event piggy-backs
 *                                     here when the integrator config
 *                                     uses the threshold API rather than
 *                                     the credits.low convenience event.
 *
 * Anything else is accepted (2xx) but treated as a no-op — we don't
 * want Oblien retrying events we haven't wired up yet.
 *
 * Signature verification (CRITICAL #6): HMAC-SHA256 over the
 * concatenation `${timestamp}.${rawBody}` using OBLIEN_WEBHOOK_SECRET.
 * The `X-Oblien-Timestamp` header carries the signing time; we reject
 * any delivery whose timestamp is more than 5 minutes from now (Stripe-
 * standard tolerance) so a captured signature can't be replayed
 * indefinitely. Compared in constant time against the hex digest in
 * `X-Oblien-Signature`. Missing header OR mismatch OR stale timestamp
 * → 401. Missing secret (env not configured) → 503: a security-
 * critical endpoint must NEVER silently accept unverified traffic, so
 * we refuse delivery loudly until the operator wires the secret.
 * The handler MUST run before c.req.json() — we need the exact bytes
 * Oblien signed.
 *
 * The exact HMAC convention (signed payload format, `sha256=` prefix,
 * timestamp tolerance) is implemented to match Stripe/GitHub norms but
 * is still pending confirmation against a real Oblien delivery — keep
 * the tolerant `sha256=`-prefix handling until we've seen one in the
 * wild and can lock the format down.
 *
 * Idempotency: oblien_webhook_event table + Postgres advisory-lock
 * pattern (same shape as billing.webhooks.ts). The lock serializes
 * concurrent deliveries of the same event_id across replicas; the
 * `processed_at` stamp short-circuits a redelivery after the handler
 * commits.
 *
 * Runs only when CLOUD_MODE=true — Oblien webhooks target the SaaS,
 * never a self-hosted instance.
 */

import type { Context } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db, schema, eq, sql, hashStringToInt } from "@repo/db";
import { safeErrorMessage } from "@repo/core";

import { env } from "../../config/env";
import { sendMail } from "../../lib/mail";
import * as quotaWrapper from "./billing-oblien-quota";

/* ───────── Constants ────────────────────────────────────────────────────── */

/** Stripe-standard 5-minute tolerance window for the signed timestamp. */
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

const HEADER_TIMESTAMP = "x-oblien-timestamp";
const HEADER_SIGNATURE = "x-oblien-signature";

/** Set of event types the dispatcher has handlers for. */
const ROUTED_EVENT_TYPES = new Set<string>([
  "credits.depleted",
  "credits.low",
  "namespace.quota.threshold",
]);

/* ───────── Signature verification ───────────────────────────────────────── */

interface SignatureCheck {
  ok: boolean;
  reason?: "no_secret" | "missing_header" | "stale_timestamp" | "bad_signature";
}

/**
 * Verify the Oblien webhook signature. Returns a tagged result so we can
 * surface a typed reason in logs without leaking branch info to the
 * caller (every failure returns the same 401 response).
 *
 *   expected = HMAC-SHA256(secret, `${timestamp}.${rawBody}`) → hex
 *   |now - timestamp| ≤ TIMESTAMP_TOLERANCE_MS
 */
function verifySignature(
  rawBody: string,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
): SignatureCheck {
  if (!env.OBLIEN_WEBHOOK_SECRET) return { ok: false, reason: "no_secret" };
  if (!timestampHeader || !signatureHeader) {
    return { ok: false, reason: "missing_header" };
  }

  // Timestamp window check. Oblien sends seconds-since-epoch like
  // Stripe; we accept both seconds and milliseconds to be robust.
  const tsNumber = Number(timestampHeader.trim());
  if (!Number.isFinite(tsNumber)) {
    return { ok: false, reason: "missing_header" };
  }
  const tsMs = tsNumber > 1e12 ? tsNumber : tsNumber * 1000;
  if (Math.abs(Date.now() - tsMs) > TIMESTAMP_TOLERANCE_MS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const signedPayload = `${timestampHeader}.${rawBody}`;
  const expected = createHmac("sha256", env.OBLIEN_WEBHOOK_SECRET)
    .update(signedPayload)
    .digest("hex");

  // Oblien may prefix the digest with `sha256=` (Stripe/GitHub convention)
  // — tolerate either form so we don't have to wait for a confirming
  // delivery to know which they ship.
  const provided = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;

  if (provided.length !== expected.length) {
    return { ok: false, reason: "bad_signature" };
  }

  try {
    const equal = timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(provided, "hex"),
    );
    return equal ? { ok: true } : { ok: false, reason: "bad_signature" };
  } catch {
    // Buffer.from on a non-hex string throws lazily on some inputs —
    // treat the failure as a mismatch rather than a 500.
    return { ok: false, reason: "bad_signature" };
  }
}

/* ───────── Payload shapes ───────────────────────────────────────────────── */

interface OblienWebhookPayload {
  event_id?: string;
  event?: string;
  namespace?: string;
  data?: {
    namespace?: string;
    threshold_percent?: number;
    used_percent?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function extractEventId(payload: OblienWebhookPayload): string | null {
  return typeof payload.event_id === "string" ? payload.event_id : null;
}

function extractEventType(payload: OblienWebhookPayload): string | null {
  return typeof payload.event === "string" ? payload.event : null;
}

function extractNamespace(payload: OblienWebhookPayload): string | null {
  if (typeof payload.namespace === "string") return payload.namespace;
  if (typeof payload.data?.namespace === "string") return payload.data.namespace;
  return null;
}

function readAcquired(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const rows = (result as { rows?: unknown }).rows;
  if (Array.isArray(rows) && rows.length > 0) {
    const first = rows[0] as { acquired?: boolean | null };
    return first.acquired === true;
  }
  return false;
}

/* ───────── Org resolution by namespace ──────────────────────────────────── */

async function findOrgByNamespace(namespace: string): Promise<string | null> {
  const [row] = await db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.oblienNamespace, namespace))
    .limit(1);
  return row?.id ?? null;
}

/* ───────── Notification helpers ─────────────────────────────────────────── */

async function notifyCreditsLow(
  orgId: string,
  usedPercent: number | null,
): Promise<void> {
  try {
    const { resolveOrgOwner } = await import("../../lib/org-actor");
    const owner = await resolveOrgOwner(orgId, "first-member");
    if (!owner?.user?.email) return;

    const pct = usedPercent != null ? Math.round(usedPercent) : 80;
    await sendMail({
      to: owner.user.email,
      subject: `You've used ${pct}% of this period's credits`,
      html: `
        <p>Hi ${owner.user.name ?? "there"},</p>
        <p>Your workspace has used <strong>${pct}%</strong> of this period's credit allowance.</p>
        <p>To avoid interruption when the cap is reached, you can top up or upgrade your plan at any time from the billing page.</p>
        <p>— Openship</p>
      `,
      text: `Your workspace has used ${pct}% of this period's credit allowance. Top up or upgrade from the billing page to avoid interruption.`,
      organizationId: orgId,
    });
  } catch (err) {
    console.warn(
      `[oblien-webhook] notifyCreditsLow failed for org ${orgId}: ${safeErrorMessage(err)}`,
    );
  }
}

/* ───────── Per-event handlers ───────────────────────────────────────────── */

async function handleCreditsDepleted(orgId: string): Promise<void> {
  await quotaWrapper.suspendIfExhausted(orgId);
}

async function handleCreditsLow(
  orgId: string,
  payload: OblienWebhookPayload,
): Promise<void> {
  const usedPercent =
    typeof payload.data?.used_percent === "number"
      ? payload.data.used_percent
      : typeof payload.data?.threshold_percent === "number"
        ? payload.data.threshold_percent
        : null;
  await notifyCreditsLow(orgId, usedPercent);
}

/* ───────── Persistence helpers ──────────────────────────────────────────── */

async function upsertWebhookEventProcessed(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  eventId: string,
  eventType: string,
): Promise<void> {
  await tx
    .insert(schema.oblienWebhookEvent)
    .values({
      oblienEventId: eventId,
      eventType,
      processedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.oblienWebhookEvent.oblienEventId,
      set: { processedAt: new Date() },
    });
}

/* ───────── Public Hono handler ──────────────────────────────────────────── */

/**
 * Hono handler for POST /api/billing/oblien-webhook.
 *
 * Mounted via `r.public(...)` so the user-auth middleware is bypassed —
 * authentication here is the HMAC signature, not a session token. The
 * handler ALWAYS reads the raw body first (signature input), then
 * parses the JSON itself; never call `c.req.json()` before
 * verification.
 */
export async function oblienWebhook(c: Context) {
  const timestampHeader = c.req.header(HEADER_TIMESTAMP);
  const signatureHeader = c.req.header(HEADER_SIGNATURE);
  const rawBody = await c.req.text();

  const sig = verifySignature(rawBody, timestampHeader, signatureHeader);
  if (!sig.ok) {
    // `no_secret` is an operator misconfiguration, not a hostile peer —
    // surface as 503 so monitoring distinguishes "we forgot to wire the
    // env" from "someone is forging signatures". Every other reason is
    // a 401 (forgery / replay / malformed delivery).
    if (sig.reason === "no_secret") {
      console.error(
        "[oblien-webhook] OBLIEN_WEBHOOK_SECRET is not configured — refusing delivery",
      );
      return c.json({ error: "Oblien webhook not configured" }, 503);
    }
    console.warn(`[oblien-webhook] signature rejected: ${sig.reason}`);
    return c.json({ error: "invalid signature" }, 401);
  }

  let payload: OblienWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as OblienWebhookPayload;
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }

  const eventId = extractEventId(payload);
  const eventType = extractEventType(payload);
  const namespace = extractNamespace(payload);

  if (!eventId || !eventType) {
    return c.json({ error: "missing event_id or event" }, 400);
  }

  const lockKey = hashStringToInt(`oblien:event:${eventId}`);

  await db.transaction(async (tx) => {
    const lockResult = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(${lockKey}) AS acquired`,
    );
    if (!readAcquired(lockResult)) {
      // Peer is processing this event. Their commit will stamp
      // processed_at — return silently (Oblien gets 2xx).
      return;
    }

    // Same-id event already finalized by a prior delivery — we hold
    // the advisory lock so no concurrent writer is touching the row.
    const [existing] = await tx
      .select({ processedAt: schema.oblienWebhookEvent.processedAt })
      .from(schema.oblienWebhookEvent)
      .where(eq(schema.oblienWebhookEvent.oblienEventId, eventId))
      .limit(1);
    if (existing?.processedAt) return;

    // Unknown / unrouted event types: accept silently so Oblien stops
    // retrying. We log so an unexpected event surface in the dashboard
    // gets noticed without throwing operators a 5xx alert.
    if (!ROUTED_EVENT_TYPES.has(eventType)) {
      console.warn(
        `[oblien-webhook] received unrouted event ${eventType} (id=${eventId}) — accepting without action`,
      );
      await upsertWebhookEventProcessed(tx, eventId, eventType);
      return;
    }

    if (!namespace) {
      console.warn(
        `[oblien-webhook] event ${eventId} (${eventType}) has no namespace — accepting without action`,
      );
      await upsertWebhookEventProcessed(tx, eventId, eventType);
      return;
    }

    const orgId = await findOrgByNamespace(namespace);
    if (!orgId) {
      // Namespace not claimed (race against provisioning, or
      // decommissioned). 2xx so Oblien gives up the retry rather
      // than pummeling us indefinitely.
      console.warn(
        `[oblien-webhook] event ${eventId} (${eventType}) namespace=${namespace} has no matching org`,
      );
      await upsertWebhookEventProcessed(tx, eventId, eventType);
      return;
    }

    try {
      switch (eventType) {
        case "credits.depleted":
          await handleCreditsDepleted(orgId);
          break;
        case "credits.low":
        case "namespace.quota.threshold":
          await handleCreditsLow(orgId, payload);
          break;
      }
      await upsertWebhookEventProcessed(tx, eventId, eventType);
    } catch (err) {
      // Re-throw — the surrounding transaction rolls back (including
      // the processed-stamp upsert and any in-handler writes that ran
      // inside this tx). Hono's onError returns 5xx and Oblien retries.
      console.error(
        `[oblien-webhook] handler failed for ${eventType} (id=${eventId}, org=${orgId}): ${safeErrorMessage(err)}`,
      );
      throw err;
    }
  });

  return c.json({ received: true });
}
