import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

/**
 * One-time codes minted during the cloud-connect handshake.
 *
 * Flow (CLOUD_MODE side):
 *   1. POST /api/cloud/connect-handoff (Better Auth session required)
 *      → generateHandoffCode() INSERTs a row, 60s TTL
 *   2. Local API GETs /api/cloud/connect-callback?code=…
 *      → POSTs to /api/cloud/exchange-code with that code
 *      → SaaS SELECTs the row, returns user + sessionToken, DELETEs the row
 *
 * Used to live in an in-memory `Map`. Moved to DB so it survives:
 *   - tsx --watch process restarts in dev (the bug that made dev unusable)
 *   - rolling deploys + multi-instance SaaS in production
 *   - manual `pm2 restart` / k8s pod recycles
 *
 * One-time use enforced by the DELETE in the exchange path. The
 * (code, expires_at) tuple is the credential; codes are 32-byte hex
 * strings (192 bits of entropy) so collision is astronomically unlikely.
 *
 * Cleanup: rows past `expires_at` are deleted at exchange time (lazy)
 * plus by the periodic purge in cloud-auth-proxy.ts (called on every
 * generate). No background sweeper required.
 */
export const cloudHandoffCode = pgTable(
  "cloud_handoff_code",
  {
    /** 32-byte hex random — the credential itself. */
    code: text("code").primaryKey(),
    /** Mirrored user identity (id, name, email, emailVerified, image). */
    userData: jsonb("user_data").notNull(),
    /** Better-Auth session token issued to the cloud user. The local
     *  instance stores this (encrypted) as cloudSessionToken. */
    sessionToken: text("session_token").notNull(),
    /** PKCE S256 challenge (base64url). When set, exchange requires a
     *  matching code_verifier — currently only used by the desktop flow. */
    codeChallenge: text("code_challenge"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("cloud_handoff_code_expires_idx").on(t.expiresAt)],
);
