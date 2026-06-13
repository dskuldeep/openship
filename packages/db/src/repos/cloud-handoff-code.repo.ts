import { and, eq, lt } from "drizzle-orm";
import type { Database } from "../client";
import { cloudHandoffCode } from "../schema";

export interface HandoffUserData {
  id: string;
  name?: string | null;
  email?: string | null;
  emailVerified?: boolean | null;
  image?: string | null;
}

export interface CreateHandoffCodeInput {
  code: string;
  userData: HandoffUserData;
  sessionToken: string;
  codeChallenge: string | null;
  /** Absolute expiry time. */
  expiresAt: Date;
}

export interface HandoffCodeRow {
  code: string;
  userData: HandoffUserData;
  sessionToken: string;
  codeChallenge: string | null;
  expiresAt: Date;
  createdAt: Date;
}

export function createCloudHandoffCodeRepo(db: Database) {
  return {
    /** INSERT a one-time handoff code. Idempotent on conflict (rare —
     *  codes are 192-bit random); on the unlikely PK clash the existing
     *  row is left alone and the caller should regenerate. */
    async create(input: CreateHandoffCodeInput): Promise<void> {
      await db
        .insert(cloudHandoffCode)
        .values({
          code: input.code,
          userData: input.userData,
          sessionToken: input.sessionToken,
          codeChallenge: input.codeChallenge,
          expiresAt: input.expiresAt,
        })
        .onConflictDoNothing({ target: cloudHandoffCode.code });
    },

    /** Atomically consume a code: read + delete in one round trip.
     *  Returns the row if found AND not expired; null otherwise.
     *  Uses `DELETE ... RETURNING` so the lookup and the one-time-use
     *  guarantee are a single SQL statement (no race window between
     *  SELECT and DELETE). */
    async consume(code: string): Promise<HandoffCodeRow | null> {
      const now = new Date();
      const rows = await db
        .delete(cloudHandoffCode)
        .where(eq(cloudHandoffCode.code, code))
        .returning();
      const row = rows[0];
      if (!row) return null;
      if (row.expiresAt < now) {
        // Already expired — we still deleted it, so no further cleanup.
        return null;
      }
      return {
        code: row.code,
        userData: row.userData as HandoffUserData,
        sessionToken: row.sessionToken,
        codeChallenge: row.codeChallenge,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
      };
    },

    /** Drop expired rows. Called lazily (on every generate) so we don't
     *  need a background sweeper. */
    async purgeExpired(): Promise<number> {
      const now = new Date();
      const deleted = await db
        .delete(cloudHandoffCode)
        .where(lt(cloudHandoffCode.expiresAt, now))
        .returning();
      return deleted.length;
    },
  };
}
