CREATE TABLE "server_tunnels" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"remote_port" integer NOT NULL,
	"remote_host" text DEFAULT '127.0.0.1' NOT NULL,
	"local_port" integer,
	"auto_start" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_tunnels" ADD CONSTRAINT "server_tunnels_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_server_tunnel_target" ON "server_tunnels" USING btree ("server_id","remote_port","remote_host");