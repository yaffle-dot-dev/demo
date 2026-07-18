ALTER TABLE "run_groups" ADD COLUMN "execution_snapshot" jsonb;

ALTER TABLE "iac_jobs" ADD COLUMN "run_group_id" uuid;
ALTER TABLE "iac_job_history" ADD COLUMN "run_group_id" uuid;

UPDATE "iac_jobs" AS job
SET "run_group_id" = deployment."run_group_id"
FROM "workspace_deployments" AS deployment
WHERE job."deployment_id" = deployment."id";

UPDATE "iac_job_history" AS job
SET "run_group_id" = deployment."run_group_id"
FROM "workspace_deployments" AS deployment
WHERE job."deployment_id" = deployment."id";

ALTER TABLE "iac_jobs"
ADD CONSTRAINT "iac_jobs_run_group_id_run_groups_id_fk"
FOREIGN KEY ("run_group_id") REFERENCES "public"."run_groups"("id") ON DELETE SET NULL;

ALTER TABLE "iac_job_history"
ADD CONSTRAINT "iac_job_history_run_group_id_run_groups_id_fk"
FOREIGN KEY ("run_group_id") REFERENCES "public"."run_groups"("id") ON DELETE SET NULL;

CREATE INDEX "iac_jobs_run_group_id_idx" ON "iac_jobs" USING btree ("run_group_id");
CREATE INDEX "iac_job_history_run_group_id_idx" ON "iac_job_history" USING btree ("run_group_id");
