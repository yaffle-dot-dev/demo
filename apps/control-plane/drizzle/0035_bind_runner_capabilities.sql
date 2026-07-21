ALTER TABLE "state_versions" ADD COLUMN "job_id" uuid;
--> statement-breakpoint
ALTER TABLE "state_versions" ADD COLUMN "upload_token_hash" text;
--> statement-breakpoint
ALTER TABLE "state_versions" ADD COLUMN "lock_generation" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "state_versions" ADD COLUMN "json_upload_completed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "lock_generation" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "tf_runs" ADD COLUMN "job_id" uuid;
--> statement-breakpoint
ALTER TABLE "state_versions" ADD CONSTRAINT "state_versions_runner_capability_check" CHECK (("run_id" IS NULL AND "job_id" IS NULL) OR ("run_id" IS NOT NULL AND "job_id" IS NOT NULL));
--> statement-breakpoint
CREATE INDEX "state_versions_run_job_idx" ON "state_versions" USING btree ("run_id", "job_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "tf_runs_job_id_unique" ON "tf_runs" USING btree ("job_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "state_versions_workspace_serial_active_unique" ON "state_versions" USING btree ("workspace_id", "serial") WHERE "status" <> 'discarded';
