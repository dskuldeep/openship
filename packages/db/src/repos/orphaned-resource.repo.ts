/**
 * Orphaned-resource repo — records leaked remote resources from a force-orphan
 * delete and feeds the GC sweep. Append on orphan, delete on successful GC,
 * bumpAttempt when a sweep can't yet reach the server.
 */

import { eq, asc, sql } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { orphanedResource } from "../schema/orphaned-resource";

export type OrphanedResource = typeof orphanedResource.$inferSelect;
export type NewOrphanedResource = typeof orphanedResource.$inferInsert;

export function createOrphanedResourceRepo(db: Database) {
  return {
    async create(
      data: Omit<NewOrphanedResource, "id" | "createdAt" | "attempts">,
    ): Promise<OrphanedResource> {
      const id = generateId("orph");
      const row: NewOrphanedResource = { id, ...data };
      await db.insert(orphanedResource).values(row);
      return { ...row, attempts: 0, createdAt: new Date() } as OrphanedResource;
    },

    /** All orphans, oldest first (GC processes them fairly). */
    async listAll(): Promise<OrphanedResource[]> {
      return db
        .select()
        .from(orphanedResource)
        .orderBy(asc(orphanedResource.createdAt));
    },

    async listByServer(serverId: string): Promise<OrphanedResource[]> {
      return db
        .select()
        .from(orphanedResource)
        .where(eq(orphanedResource.serverId, serverId));
    },

    async delete(id: string): Promise<void> {
      await db.delete(orphanedResource).where(eq(orphanedResource.id, id));
    },

    /** Record a failed/deferred GC attempt so the sweep can back off / observe. */
    async bumpAttempt(id: string): Promise<void> {
      await db
        .update(orphanedResource)
        .set({ attempts: sql`${orphanedResource.attempts} + 1`, lastAttemptAt: new Date() })
        .where(eq(orphanedResource.id, id));
    },
  };
}
