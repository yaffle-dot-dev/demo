ALTER TABLE "run_groups" ADD COLUMN "execution_snapshot" jsonb;

ALTER TABLE "iac_jobs" ADD COLUMN "run_group_id" uuid;
ALTER TABLE "iac_job_history" ADD COLUMN "run_group_id" uuid;
ALTER TABLE "approvals" ADD COLUMN "run_group_id" uuid;

-- Pre-snapshot jobs cannot be executed safely because their exact source and
-- configuration are unknown. Fail their mutable projections, archive the jobs,
-- and remove them from the active queue instead of guessing an association.
UPDATE "workspace_deployments" AS deployment
SET "status" = 'failed', "status_changed_at" = NOW()
WHERE EXISTS (
  SELECT 1
  FROM "iac_jobs" AS job
  WHERE
    job."deployment_id" = deployment."id"
    AND job."run_group_id" IS NULL
    AND job."status" IN ('queued', 'running')
);

UPDATE "run_groups" AS run_group
SET "status" = 'failed', "completed_at" = COALESCE(run_group."completed_at", NOW())
WHERE
  run_group."execution_snapshot" IS NULL
  AND run_group."status" IN ('pending', 'running')
  AND EXISTS (
    SELECT 1
    FROM "workspace_deployments" AS deployment
    JOIN "iac_jobs" AS job ON job."deployment_id" = deployment."id"
    WHERE
      deployment."run_group_id" = run_group."id"
      AND job."run_group_id" IS NULL
      AND job."status" IN ('queued', 'running')
  );

INSERT INTO "iac_job_history" (
  "id",
  "deployment_id",
  "run_group_id",
  "job_type",
  "status",
  "worker_id",
  "last_heartbeat",
  "spawn_lease_token",
  "spawn_lease_holder",
  "spawn_lease_expires_at",
  "queued_at",
  "dispatched_at",
  "last_spawn_attempt_at",
  "started_at",
  "blocked_at",
  "completed_at",
  "result",
  "blocked_reason",
  "error_message",
  "attempts",
  "spawn_attempts",
  "max_attempts"
)
SELECT
  job."id",
  job."deployment_id",
  NULL,
  job."job_type",
  'cancelled',
  job."worker_id",
  job."last_heartbeat",
  job."spawn_lease_token",
  job."spawn_lease_holder",
  job."spawn_lease_expires_at",
  job."queued_at",
  job."dispatched_at",
  job."last_spawn_attempt_at",
  job."started_at",
  job."blocked_at",
  COALESCE(job."completed_at", NOW()),
  job."result",
  job."blocked_reason",
  COALESCE(job."error_message", 'Cancelled during immutable execution snapshot migration'),
  job."attempts",
  job."spawn_attempts",
  job."max_attempts"
FROM "iac_jobs" AS job
WHERE job."run_group_id" IS NULL AND job."status" IN ('queued', 'running')
ON CONFLICT ("id") DO NOTHING;

DELETE FROM "iac_jobs"
WHERE "run_group_id" IS NULL AND "status" IN ('queued', 'running');

-- Active scanners created before snapshots can otherwise project mutable inputs
-- after this migration. Fail both the scan and its owning run group.
UPDATE "scan_jobs" AS scan
SET
  "status" = 'failed',
  "completed_at" = COALESCE(scan."completed_at", NOW()),
  "error_message" = COALESCE(scan."error_message", 'Cancelled during immutable execution snapshot migration')
FROM "run_groups" AS run_group
WHERE
  scan."run_group_id" = run_group."id"
  AND run_group."execution_snapshot" IS NULL
  AND scan."status" IN ('queued', 'running');

UPDATE "run_groups" AS run_group
SET
  "status" = 'failed',
  "completed_at" = COALESCE(run_group."completed_at", NOW())
WHERE
  run_group."execution_snapshot" IS NULL
  AND run_group."status" IN ('pending', 'running')
  AND EXISTS (
    SELECT 1
    FROM "scan_jobs" AS scan
    WHERE scan."run_group_id" = run_group."id" AND scan."status" = 'failed'
  );

-- Block old application instances from enqueueing new unbound work during a
-- rolling deployment. Failed transient groups remain valid for config errors.
ALTER TABLE "iac_jobs" ALTER COLUMN "run_group_id" SET NOT NULL;
ALTER TABLE "run_groups"
ADD CONSTRAINT "run_groups_transient_execution_snapshot_check"
CHECK (
  "environment_kind" <> 'transient'
  OR "execution_snapshot" IS NOT NULL
  OR "status" = 'failed'
);

ALTER TABLE "iac_jobs"
ADD CONSTRAINT "iac_jobs_run_group_id_run_groups_id_fk"
FOREIGN KEY ("run_group_id") REFERENCES "public"."run_groups"("id") ON DELETE CASCADE;

ALTER TABLE "iac_job_history"
ADD CONSTRAINT "iac_job_history_run_group_id_run_groups_id_fk"
FOREIGN KEY ("run_group_id") REFERENCES "public"."run_groups"("id") ON DELETE SET NULL;

ALTER TABLE "approvals"
ADD CONSTRAINT "approvals_run_group_id_run_groups_id_fk"
FOREIGN KEY ("run_group_id") REFERENCES "public"."run_groups"("id");

CREATE INDEX "iac_jobs_run_group_id_idx" ON "iac_jobs" USING btree ("run_group_id");
CREATE INDEX "iac_job_history_run_group_id_idx" ON "iac_job_history" USING btree ("run_group_id");
