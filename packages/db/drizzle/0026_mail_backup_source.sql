ALTER TABLE "backup_policy" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_policy" ADD COLUMN "source_kind" text DEFAULT 'service' NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_policy" ADD COLUMN "mail_server_id" text;--> statement-breakpoint
ALTER TABLE "backup_restore" ADD COLUMN "fork_mail_server_id" text;--> statement-breakpoint
ALTER TABLE "backup_run" ADD COLUMN "source_kind" text DEFAULT 'service' NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_run" ADD COLUMN "mail_server_id" text;--> statement-breakpoint
ALTER TABLE "backup_policy" ADD CONSTRAINT "backup_policy_mail_server_id_mail_servers_server_id_fk" FOREIGN KEY ("mail_server_id") REFERENCES "public"."mail_servers"("server_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_restore" ADD CONSTRAINT "backup_restore_fork_mail_server_id_mail_servers_server_id_fk" FOREIGN KEY ("fork_mail_server_id") REFERENCES "public"."mail_servers"("server_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_run" ADD CONSTRAINT "backup_run_mail_server_id_mail_servers_server_id_fk" FOREIGN KEY ("mail_server_id") REFERENCES "public"."mail_servers"("server_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_backup_policy_mail_server" ON "backup_policy" USING btree ("mail_server_id") WHERE "backup_policy"."mail_server_id" IS NOT NULL AND "backup_policy"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_backup_policy_mail_server" ON "backup_policy" USING btree ("mail_server_id");