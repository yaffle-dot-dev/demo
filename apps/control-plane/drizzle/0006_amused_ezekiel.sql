CREATE TYPE "public"."scan_job_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "scan_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_group_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"status" "scan_job_status" DEFAULT 'queued' NOT NULL,
	"worker_id" text,
	"last_heartbeat" timestamp with time zone,
	"repo_url" text NOT NULL,
	"ref" text NOT NULL,
	"head_sha" text NOT NULL,
	"installation_token" text,
	"org_slug" text NOT NULL,
	"result" jsonb,
	"error_message" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "scan_jobs" ADD CONSTRAINT "scan_jobs_run_group_id_run_groups_id_fk" FOREIGN KEY ("run_group_id") REFERENCES "public"."run_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_jobs" ADD CONSTRAINT "scan_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scan_jobs_status_idx" ON "scan_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "scan_jobs_run_group_id_idx" ON "scan_jobs" USING btree ("run_group_id");
