import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "../client";
import { serviceTerminalSessions } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ServiceTerminalSession = typeof serviceTerminalSessions.$inferSelect;
export type NewServiceTerminalSession =
  typeof serviceTerminalSessions.$inferInsert;

/** Re-export the shared exit-reason enum so consumers only need one import. */
export type {
  TerminalExitReason,
} from "./terminal-session.repo";

// ─── Repository ──────────────────────────────────────────────────────────────

export function createServiceTerminalSessionRepo(db: Database) {
  return {
    async open(data: {
      userId: string;
      serviceId: string;
      clientIp?: string | null;
      userAgent?: string | null;
    }): Promise<{ id: string }> {
      const [row] = await db
        .insert(serviceTerminalSessions)
        .values({
          userId: data.userId,
          serviceId: data.serviceId,
          clientIp: data.clientIp ?? null,
          userAgent: data.userAgent ?? null,
        })
        .returning();
      return { id: row.id };
    },

    async close(
      id: string,
      data: {
        exitCode?: number | null;
        exitReason: import("./terminal-session.repo").TerminalExitReason;
      },
    ): Promise<void> {
      await db
        .update(serviceTerminalSessions)
        .set({
          endedAt: new Date(),
          exitCode: data.exitCode ?? null,
          exitReason: data.exitReason,
        })
        .where(eq(serviceTerminalSessions.id, id));
    },

    async countActiveByUser(userId: string): Promise<number> {
      const [row] = await db
        .select({ count: count() })
        .from(serviceTerminalSessions)
        .where(
          and(
            eq(serviceTerminalSessions.userId, userId),
            isNull(serviceTerminalSessions.endedAt),
          ),
        );
      return Number(row?.count ?? 0);
    },

    async closeAllActive(
      reason: import("./terminal-session.repo").TerminalExitReason = "server_error",
    ): Promise<number> {
      const updated = await db
        .update(serviceTerminalSessions)
        .set({ endedAt: new Date(), exitReason: reason })
        .where(isNull(serviceTerminalSessions.endedAt))
        .returning();
      return updated.length;
    },

    async listRecent(opts: {
      userId?: string;
      serviceId?: string;
      limit?: number;
    }): Promise<ServiceTerminalSession[]> {
      const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
      const where = [
        opts.userId ? eq(serviceTerminalSessions.userId, opts.userId) : undefined,
        opts.serviceId
          ? eq(serviceTerminalSessions.serviceId, opts.serviceId)
          : undefined,
      ].filter(Boolean);
      return db.query.serviceTerminalSessions.findMany({
        where: where.length ? and(...(where as any[])) : undefined,
        orderBy: [desc(serviceTerminalSessions.startedAt)],
        limit,
      });
    },
  };
}
