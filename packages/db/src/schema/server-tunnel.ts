import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { servers } from "./servers";

// ─── Server port-forward tunnels ───────────────────────────────────────────────

/**
 * Port-forward tunnel CONFIGS — Desktop-only.
 *
 * One row per saved forward (a remote port on a server → localhost on the
 * user's desktop). This is configuration ONLY; the live tunnels (open local
 * sockets) live in RAM in `ssh-tunnel-manager`. `auto_start` rows are
 * re-established at boot by the desktop startup hook. On a VPS/SaaS orchestrator
 * the whole feature is gated off, so this table is simply unused there.
 */
export const serverTunnels = pgTable(
  "server_tunnels",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),

    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),

    /** Port on the remote server to forward. */
    remotePort: integer("remote_port").notNull(),
    /** Host the remote port lives on, as seen FROM the server (usually loopback). */
    remoteHost: text("remote_host").notNull().default("127.0.0.1"),
    /** Preferred / last-assigned local port (the OS may pick another if busy). */
    localPort: integer("local_port"),
    /** Re-open this tunnel automatically on app startup (desktop). */
    autoStart: boolean("auto_start").notNull().default(false),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // One config per (server, remote target). Upserts key off this.
    uniqueIndex("uq_server_tunnel_target").on(
      table.serverId,
      table.remotePort,
      table.remoteHost,
    ),
  ],
);
