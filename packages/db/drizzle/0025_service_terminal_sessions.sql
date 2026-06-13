CREATE TABLE "service_terminal_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"service_id" text NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"exit_code" integer,
	"exit_reason" text,
	"client_ip" text,
	"user_agent" text
);
--> statement-breakpoint
ALTER TABLE "service_terminal_sessions" ADD CONSTRAINT "service_terminal_sessions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "service_terminal_sessions" ADD CONSTRAINT "service_terminal_sessions_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "service_terminal_sessions_user_idx" ON "service_terminal_sessions" ("user_id","started_at");
--> statement-breakpoint
CREATE INDEX "service_terminal_sessions_service_idx" ON "service_terminal_sessions" ("service_id","started_at");
