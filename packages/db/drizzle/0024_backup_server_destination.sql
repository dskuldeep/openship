-- backup_destination.server_id — link to an existing openship `servers`
-- row when kind='openship_server'. The destination reuses the server's
-- SSH credentials so users don't re-enter them for backups.
--
-- ON DELETE SET NULL keeps backup_run history intact when a server is
-- removed (the artifact bytes may still exist at the destination).

ALTER TABLE "backup_destination"
  ADD COLUMN "server_id" text;
--> statement-breakpoint
ALTER TABLE "backup_destination"
  ADD CONSTRAINT "backup_destination_server_id_servers_id_fk"
  FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE SET NULL;
