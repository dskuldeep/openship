CREATE TABLE "orphaned_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"server_id" text,
	"resource_type" text NOT NULL,
	"ref" text NOT NULL,
	"project_id" text,
	"label" text,
	"runtime_mode" text,
	"payload" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orphaned_resource" ADD CONSTRAINT "orphaned_resource_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orphaned_resource_server_idx" ON "orphaned_resource" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "orphaned_resource_org_created_idx" ON "orphaned_resource" USING btree ("organization_id","created_at");