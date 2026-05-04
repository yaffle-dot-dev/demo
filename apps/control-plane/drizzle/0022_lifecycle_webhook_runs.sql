CREATE TABLE "lifecycle_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"principal_id" uuid NOT NULL,
	"repo_binding_id" uuid NOT NULL,
	"environment_name" text NOT NULL,
	"execution_mode" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lifecycle_runs" ADD CONSTRAINT "lifecycle_runs_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_runs" ADD CONSTRAINT "lifecycle_runs_repo_binding_id_principal_repo_bindings_id_fk" FOREIGN KEY ("repo_binding_id") REFERENCES "public"."principal_repo_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lifecycle_runs_repo_env_idx" ON "lifecycle_runs" USING btree ("repo_binding_id","environment_name","created_at");--> statement-breakpoint
CREATE INDEX "lifecycle_runs_principal_idx" ON "lifecycle_runs" USING btree ("principal_id","created_at");--> statement-breakpoint

CREATE TABLE "lifecycle_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"workspace_path" text NOT NULL,
	"key" text NOT NULL,
	"phase" text NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"failure_policy" text NOT NULL,
	"scopes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"destination_url" text NOT NULL,
	"destination_class" text NOT NULL,
	"dispatch_mode" text NOT NULL,
	"summary" text,
	"reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lifecycle_items_run_workspace_key_unique" UNIQUE("run_id","workspace_path","key")
);
--> statement-breakpoint
ALTER TABLE "lifecycle_items" ADD CONSTRAINT "lifecycle_items_run_id_lifecycle_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."lifecycle_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lifecycle_items_run_idx" ON "lifecycle_items" USING btree ("run_id","phase","workspace_path");--> statement-breakpoint

CREATE TABLE "lifecycle_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lifecycle_events" ADD CONSTRAINT "lifecycle_events_item_id_lifecycle_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."lifecycle_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lifecycle_events_item_idx" ON "lifecycle_events" USING btree ("item_id","created_at");--> statement-breakpoint

CREATE TABLE "lifecycle_completion_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lifecycle_completion_tokens" ADD CONSTRAINT "lifecycle_completion_tokens_item_id_lifecycle_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."lifecycle_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lifecycle_completion_tokens_expires_idx" ON "lifecycle_completion_tokens" USING btree ("expires_at");
