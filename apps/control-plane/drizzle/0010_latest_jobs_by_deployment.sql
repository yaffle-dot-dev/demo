CREATE INDEX IF NOT EXISTS "iac_jobs_deployment_queued_at_idx"
ON "iac_jobs" ("deployment_id" ASC, "queued_at" DESC);
