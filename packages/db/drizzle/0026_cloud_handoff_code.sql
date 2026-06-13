CREATE TABLE "cloud_handoff_code" (
	"code" text PRIMARY KEY NOT NULL,
	"user_data" jsonb NOT NULL,
	"session_token" text NOT NULL,
	"code_challenge" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cloud_handoff_code_expires_idx" ON "cloud_handoff_code" ("expires_at");
