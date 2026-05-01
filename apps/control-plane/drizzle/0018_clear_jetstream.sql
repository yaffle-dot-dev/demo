CREATE TABLE "run_group_workspace_metadata" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_group_id" uuid NOT NULL,
	"workspace_path" text NOT NULL,
	"provider_requirements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"extraction_status" text DEFAULT 'pending' NOT NULL,
	"degradation_kind" text,
	"error_kind" text,
	"error_message" text,
	"retryable" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'scan_job' NOT NULL,
	"extracted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_group_workspace_metadata_group_workspace" UNIQUE("run_group_id","workspace_path")
);
--> statement-breakpoint
ALTER TABLE "run_group_workspace_metadata" ADD CONSTRAINT "run_group_workspace_metadata_run_group_id_run_groups_id_fk" FOREIGN KEY ("run_group_id") REFERENCES "public"."run_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_group_workspace_metadata_group_idx" ON "run_group_workspace_metadata" USING btree ("run_group_id");--> statement-breakpoint
CREATE INDEX "run_group_workspace_metadata_status_idx" ON "run_group_workspace_metadata" USING btree ("extraction_status");
