-- Backup foundation — four tables for the adapter-based backup system.
-- See packages/db/src/schema/backup.ts for column semantics.

CREATE TABLE "backup_destination" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "kind" text NOT NULL,
  "endpoint" text,
  "region" text,
  "bucket" text,
  "path_prefix" text,
  "ssh_host" text,
  "ssh_port" integer,
  "ssh_user" text,
  "access_key_id_enc" text,
  "secret_access_key_enc" text,
  "sftp_password_enc" text,
  "sftp_private_key_enc" text,
  "sftp_key_passphrase_enc" text,
  "last_verified_at" timestamp,
  "last_verify_error" text,
  "is_default" boolean NOT NULL DEFAULT false,
  "deleted_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_backup_destination_user_name_active"
  ON "backup_destination"("user_id", "name")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "idx_backup_destination_user"
  ON "backup_destination"("user_id");
--> statement-breakpoint

CREATE TABLE "backup_policy" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
  "service_id" text REFERENCES "service"("id") ON DELETE CASCADE,
  "destination_id" text NOT NULL REFERENCES "backup_destination"("id") ON DELETE RESTRICT,
  "enabled" boolean NOT NULL DEFAULT true,
  "cron_expression" text,
  "trigger_on_pre_deploy" boolean NOT NULL DEFAULT false,
  "webhook_token" text,
  "webhook_last_fired_at" timestamp,
  "retain_count" integer,
  "retain_days" integer,
  "payload_kind" text NOT NULL DEFAULT 'auto',
  "payload_config" jsonb DEFAULT '{}'::jsonb,
  "pre_hook" text,
  "post_hook" text,
  "hook_timeout_seconds" integer NOT NULL DEFAULT 300,
  "compression_algo" text NOT NULL DEFAULT 'zstd',
  "encryption_at_rest" boolean NOT NULL DEFAULT false,
  "created_by" text REFERENCES "user"("id"),
  "deleted_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_backup_policy_project_service"
  ON "backup_policy"("project_id", "service_id")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_backup_policy_webhook_token"
  ON "backup_policy"("webhook_token")
  WHERE "webhook_token" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_backup_policy_project"
  ON "backup_policy"("project_id");
--> statement-breakpoint
CREATE INDEX "idx_backup_policy_destination"
  ON "backup_policy"("destination_id");
--> statement-breakpoint

CREATE TABLE "backup_run" (
  "id" text PRIMARY KEY NOT NULL,
  "policy_id" text REFERENCES "backup_policy"("id") ON DELETE SET NULL,
  "destination_id" text REFERENCES "backup_destination"("id") ON DELETE SET NULL,
  "project_id" text REFERENCES "project"("id") ON DELETE SET NULL,
  "service_id" text REFERENCES "service"("id") ON DELETE SET NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'queued',
  "triggered_by" text NOT NULL,
  "triggered_by_user_id" text REFERENCES "user"("id"),
  "client_ip" text,
  "started_at" timestamp NOT NULL DEFAULT now(),
  "finished_at" timestamp,
  "last_event_at" timestamp NOT NULL DEFAULT now(),
  "object_key_prefix" text,
  "manifest_key" text,
  "bytes_transferred" bigint,
  "artifacts" jsonb DEFAULT '[]'::jsonb,
  "error_message" text,
  "hook_log" text,
  "retention_locked_until" timestamp,
  "deleted_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "idx_backup_run_user_started"
  ON "backup_run"("user_id", "started_at");
--> statement-breakpoint
CREATE INDEX "idx_backup_run_destination_started"
  ON "backup_run"("destination_id", "started_at");
--> statement-breakpoint
CREATE INDEX "idx_backup_run_project_started"
  ON "backup_run"("project_id", "started_at");
--> statement-breakpoint
CREATE INDEX "idx_backup_run_in_flight"
  ON "backup_run"("status")
  WHERE "status" IN ('queued','preparing','snapshotting','uploading','verifying');
--> statement-breakpoint

CREATE TABLE "backup_restore" (
  "id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL REFERENCES "backup_run"("id") ON DELETE RESTRICT,
  "destination_id" text NOT NULL REFERENCES "backup_destination"("id") ON DELETE RESTRICT,
  "project_id" text REFERENCES "project"("id") ON DELETE SET NULL,
  "service_id" text REFERENCES "service"("id") ON DELETE SET NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'queued',
  "mode" text NOT NULL DEFAULT 'in_place',
  "fork_service_id" text REFERENCES "service"("id") ON DELETE SET NULL,
  "started_at" timestamp NOT NULL DEFAULT now(),
  "finished_at" timestamp,
  "last_event_at" timestamp NOT NULL DEFAULT now(),
  "bytes_restored" bigint,
  "error_message" text,
  "client_ip" text,
  "confirmation_token" text
);
--> statement-breakpoint
CREATE INDEX "idx_backup_restore_user_started"
  ON "backup_restore"("user_id", "started_at");
--> statement-breakpoint
CREATE INDEX "idx_backup_restore_run"
  ON "backup_restore"("run_id");
