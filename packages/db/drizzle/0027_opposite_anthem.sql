ALTER TABLE "service" ADD COLUMN "namespace_volumes" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Grandfather every EXISTING service to bare (un-scoped) volume names so their
-- on-disk data is not orphaned. Rows created AFTER this migration take the
-- column default (true) and get project-scoped volumes. Load-bearing: without
-- it, ADD COLUMN DEFAULT true would scope existing services and lose their data.
UPDATE "service" SET "namespace_volumes" = false;