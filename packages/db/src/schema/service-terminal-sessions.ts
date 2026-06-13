import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { service } from "./service";

// ─── Service terminal sessions ───────────────────────────────────────────────

/**
 * Audit log of interactive terminal sessions opened against a deployed
 * service (not a server). Sibling of `terminal_sessions` — same column
 * shape, just bound to a service row instead of a server row.
 *
 * One row per session, written at open + finalized at close. Stores ONLY
 * session metadata — never keystrokes, never PTY bytes.
 *
 * `endedAt = NULL` means the session is currently active. A boot-time
 * sweep finalizes orphaned rows with reason='server_error'.
 *
 * ON DELETE CASCADE on both FKs.
 */
export const serviceTerminalSessions = pgTable(
  "service_terminal_sessions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),

    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    serviceId: text("service_id")
      .notNull()
      .references(() => service.id, { onDelete: "cascade" }),

    startedAt: timestamp("started_at").notNull().defaultNow(),
    endedAt: timestamp("ended_at"),

    exitCode: integer("exit_code"),
    exitReason: text("exit_reason"),

    clientIp: text("client_ip"),
    userAgent: text("user_agent"),
  },
  (t) => [
    index("service_terminal_sessions_user_idx").on(t.userId, t.startedAt),
    index("service_terminal_sessions_service_idx").on(t.serviceId, t.startedAt),
  ],
);
