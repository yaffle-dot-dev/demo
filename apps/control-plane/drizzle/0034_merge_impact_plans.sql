ALTER TABLE "iac_jobs" ADD COLUMN "plan_purpose" text DEFAULT 'environment' NOT NULL;
ALTER TABLE "iac_jobs" ADD COLUMN "target_workspace_id" uuid;
ALTER TABLE "iac_jobs" ADD COLUMN "target_state_version_id" uuid;

ALTER TABLE "iac_job_history" ADD COLUMN "plan_purpose" text DEFAULT 'environment' NOT NULL;
ALTER TABLE "iac_job_history" ADD COLUMN "target_workspace_id" uuid;
ALTER TABLE "iac_job_history" ADD COLUMN "target_state_version_id" uuid;

ALTER TABLE "tf_runs" ADD COLUMN "plan_purpose" text DEFAULT 'environment' NOT NULL;
ALTER TABLE "tf_runs" ADD COLUMN "target_workspace_id" uuid;
ALTER TABLE "tf_runs" ADD COLUMN "target_state_version_id" uuid;

ALTER TABLE "iac_jobs"
  ADD CONSTRAINT "iac_jobs_target_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("target_workspace_id") REFERENCES "public"."workspaces"("id");
ALTER TABLE "iac_jobs"
  ADD CONSTRAINT "iac_jobs_target_state_version_id_state_versions_id_fk"
  FOREIGN KEY ("target_state_version_id") REFERENCES "public"."state_versions"("id");
ALTER TABLE "iac_job_history"
  ADD CONSTRAINT "iac_job_history_target_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("target_workspace_id") REFERENCES "public"."workspaces"("id");
ALTER TABLE "iac_job_history"
  ADD CONSTRAINT "iac_job_history_target_state_version_id_state_versions_id_fk"
  FOREIGN KEY ("target_state_version_id") REFERENCES "public"."state_versions"("id");
ALTER TABLE "tf_runs"
  ADD CONSTRAINT "tf_runs_target_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("target_workspace_id") REFERENCES "public"."workspaces"("id");
ALTER TABLE "tf_runs"
  ADD CONSTRAINT "tf_runs_target_state_version_id_state_versions_id_fk"
  FOREIGN KEY ("target_state_version_id") REFERENCES "public"."state_versions"("id");

ALTER TABLE "iac_jobs"
  ADD CONSTRAINT "iac_jobs_plan_target_check"
  CHECK (
    ("plan_purpose" = 'environment' AND "target_workspace_id" IS NULL AND "target_state_version_id" IS NULL)
    OR
    ("job_type" = 'plan' AND "plan_purpose" = 'merge_impact' AND "target_workspace_id" IS NOT NULL AND "target_state_version_id" IS NOT NULL)
  );
ALTER TABLE "iac_job_history"
  ADD CONSTRAINT "iac_job_history_plan_target_check"
  CHECK (
    ("plan_purpose" = 'environment' AND "target_workspace_id" IS NULL AND "target_state_version_id" IS NULL)
    OR
    ("job_type" = 'plan' AND "plan_purpose" = 'merge_impact' AND "target_workspace_id" IS NOT NULL AND "target_state_version_id" IS NOT NULL)
  );
ALTER TABLE "tf_runs"
  ADD CONSTRAINT "tf_runs_plan_target_check"
  CHECK (
    ("plan_purpose" = 'environment' AND "target_workspace_id" IS NULL AND "target_state_version_id" IS NULL)
    OR
    ("run_type" = 'plan' AND "plan_purpose" = 'merge_impact' AND "target_workspace_id" IS NOT NULL AND "target_state_version_id" IS NOT NULL)
  );

CREATE INDEX "iac_jobs_target_workspace_id_idx" ON "iac_jobs" USING btree ("target_workspace_id");
CREATE INDEX "iac_job_history_target_workspace_id_idx"
  ON "iac_job_history" USING btree ("target_workspace_id");
CREATE INDEX "tf_runs_target_workspace_id_idx" ON "tf_runs" USING btree ("target_workspace_id");
