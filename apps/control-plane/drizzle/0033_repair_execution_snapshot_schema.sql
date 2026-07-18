-- Repair production databases whose Drizzle journal advanced without the
-- physical schema from migrations 0030-0032. Every operation is idempotent so
-- databases that already have part or all of the schema converge safely.

-- Drizzle checks its journal before opening the migration transaction. Serialize
-- this repair so concurrent deploys cannot race between catalog checks and DDL.
SELECT pg_advisory_xact_lock(hashtext('yaffle-control-plane-schema-repair-0033'));

DO $repair$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'environment_kind'
  ) THEN
    ALTER TABLE "workspaces" ADD COLUMN "environment_kind" text;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'environment_name'
  ) THEN
    ALTER TABLE "workspaces" ADD COLUMN "environment_name" text;
  END IF;
END $repair$;

DO $repair$
DECLARE
  invalid_preview_exists boolean;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'environment'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'pr_number'
  ) THEN
    EXECUTE $sql$
      SELECT EXISTS (
        SELECT 1 FROM "workspaces"
        WHERE "environment" = 'preview' AND "pr_number" IS NULL
      )
    $sql$ INTO invalid_preview_exists;

    IF invalid_preview_exists THEN
      RAISE EXCEPTION 'Cannot repair preview workspace without GitHub PR source metadata';
    END IF;

    EXECUTE $sql$
      UPDATE "workspaces"
      SET
        "environment_kind" = COALESCE(
          "environment_kind",
          CASE WHEN "environment" = 'preview' THEN 'transient' ELSE 'named' END
        ),
        "environment_name" = COALESCE(
          "environment_name",
          CASE
            WHEN "environment" = 'preview' AND "pr_number" IS NOT NULL
              THEN 'pr-' || "pr_number"::text
            ELSE "environment"
          END
        )
    $sql$;
  ELSIF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE
      table_schema = 'public'
      AND table_name = 'workspaces'
      AND column_name IN ('environment', 'pr_number')
  ) THEN
    RAISE EXCEPTION 'Cannot repair workspace environment identity from partial legacy columns';
  ELSIF EXISTS (
    SELECT 1 FROM "workspaces"
    WHERE "environment_kind" IS NULL OR "environment_name" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot repair workspace environment identity without legacy source columns';
  END IF;
END $repair$;

DO $repair$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE
      table_schema = 'public'
      AND table_name = 'workspaces'
      AND column_name = 'environment_kind'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE "workspaces" ALTER COLUMN "environment_kind" SET NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE
      table_schema = 'public'
      AND table_name = 'workspaces'
      AND column_name = 'environment_name'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE "workspaces" ALTER COLUMN "environment_name" SET NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspaces_environment_kind_check' AND conrelid = 'workspaces'::regclass
  ) THEN
    ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_environment_kind_check"
      CHECK ("environment_kind" IN ('named', 'transient'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspaces_environment_name_check' AND conrelid = 'workspaces'::regclass
  ) THEN
    ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_environment_name_check"
      CHECK (length(btrim("environment_name")) > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE
      conname = 'workspace_deployments_environment_kind_check'
      AND conrelid = 'workspace_deployments'::regclass
  ) THEN
    ALTER TABLE "workspace_deployments"
      ADD CONSTRAINT "workspace_deployments_environment_kind_check"
      CHECK ("environment_kind" IN ('named', 'transient'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'run_groups_environment_kind_check' AND conrelid = 'run_groups'::regclass
  ) THEN
    ALTER TABLE "run_groups" ADD CONSTRAINT "run_groups_environment_kind_check"
      CHECK ("environment_kind" IN ('named', 'transient'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE
      conname = 'workspaces_environment_identity_unique'
      AND conrelid = 'workspaces'::regclass
  ) THEN
    ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_environment_identity_unique" UNIQUE (
      "org_id",
      "repo",
      "workspace_path",
      "environment_kind",
      "environment_name"
    );
  END IF;
END $repair$;

DO $repair$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'environment'
  ) THEN
    ALTER TABLE "workspaces" DROP COLUMN "environment";
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'pr_number'
  ) THEN
    ALTER TABLE "workspaces" DROP COLUMN "pr_number";
  END IF;
END $repair$;

DO $repair$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE
      table_schema = 'public'
      AND table_name = 'scan_jobs'
      AND column_name = 'automatic_isolation_workspace_paths'
  ) THEN
    ALTER TABLE "scan_jobs"
      ADD COLUMN "automatic_isolation_workspace_paths" jsonb NOT NULL DEFAULT '[]'::jsonb;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'run_groups' AND column_name = 'execution_snapshot'
  ) THEN
    ALTER TABLE "run_groups" ADD COLUMN "execution_snapshot" jsonb;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'iac_jobs' AND column_name = 'run_group_id'
  ) THEN
    ALTER TABLE "iac_jobs" ADD COLUMN "run_group_id" uuid;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'iac_job_history' AND column_name = 'run_group_id'
  ) THEN
    ALTER TABLE "iac_job_history" ADD COLUMN "run_group_id" uuid;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'approvals' AND column_name = 'run_group_id'
  ) THEN
    ALTER TABLE "approvals" ADD COLUMN "run_group_id" uuid;
  END IF;
END $repair$;

-- Jobs created before immutable snapshots cannot be executed safely. Preserve
-- their history, fail their projections, and remove them from the active queue.
UPDATE "workspace_deployments" AS deployment
SET "status" = 'failed', "status_changed_at" = NOW()
WHERE EXISTS (
  SELECT 1
  FROM "iac_jobs" AS job
  WHERE
    job."deployment_id" = deployment."id"
    AND NOT EXISTS (
      SELECT 1
      FROM "run_groups" AS run_group
      WHERE
        run_group."id" = job."run_group_id"
        AND run_group."execution_snapshot" IS NOT NULL
    )
    AND job."status" IN ('queued', 'running')
);

UPDATE "tf_runs" AS tf_run
SET
  "status" = 'failed',
  "completed_at" = COALESCE(tf_run."completed_at", NOW()),
  "error_message" = COALESCE(
    tf_run."error_message",
    'Cancelled during immutable execution snapshot schema repair'
  )
WHERE
  tf_run."status" = 'running'
  AND EXISTS (
    SELECT 1
    FROM "iac_jobs" AS job
    WHERE
      job."deployment_id" = tf_run."deployment_id"
      AND (job."run_group_id" IS NULL OR job."run_group_id" = tf_run."run_group_id")
      AND NOT EXISTS (
        SELECT 1
        FROM "run_groups" AS run_group
        WHERE
          run_group."id" = job."run_group_id"
          AND run_group."execution_snapshot" IS NOT NULL
      )
  );

UPDATE "scan_jobs" AS scan
SET
  "status" = 'failed',
  "completed_at" = COALESCE(scan."completed_at", NOW()),
  "error_message" = COALESCE(
    scan."error_message",
    'Cancelled during immutable execution snapshot schema repair'
  )
FROM "run_groups" AS run_group
WHERE
  scan."run_group_id" = run_group."id"
  AND run_group."execution_snapshot" IS NULL
  AND scan."status" IN ('queued', 'running');

UPDATE "run_groups"
SET "status" = 'failed', "completed_at" = COALESCE("completed_at", NOW())
WHERE
  "execution_snapshot" IS NULL
  AND "status" IN ('pending', 'scanning', 'running');

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
  job."run_group_id",
  job."job_type",
  CASE
    WHEN job."status" IN ('queued', 'running') THEN 'cancelled'::iac_job_status
    ELSE job."status"
  END,
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
  CASE
    WHEN job."status" IN ('queued', 'running') THEN COALESCE(job."completed_at", NOW())
    ELSE job."completed_at"
  END,
  job."result",
  job."blocked_reason",
  CASE
    WHEN job."status" IN ('queued', 'running') THEN COALESCE(
      job."error_message",
      'Cancelled during immutable execution snapshot schema repair'
    )
    ELSE job."error_message"
  END,
  job."attempts",
  job."spawn_attempts",
  job."max_attempts"
FROM "iac_jobs" AS job
WHERE NOT EXISTS (
  SELECT 1
  FROM "run_groups" AS run_group
  WHERE
    run_group."id" = job."run_group_id"
    AND run_group."execution_snapshot" IS NOT NULL
)
ON CONFLICT ("id") DO NOTHING;

DELETE FROM "iac_jobs" AS job
WHERE NOT EXISTS (
  SELECT 1
  FROM "run_groups" AS run_group
  WHERE
    run_group."id" = job."run_group_id"
    AND run_group."execution_snapshot" IS NOT NULL
);

DO $repair$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE
      table_schema = 'public'
      AND table_name = 'iac_jobs'
      AND column_name = 'run_group_id'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE "iac_jobs" ALTER COLUMN "run_group_id" SET NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE
      conname = 'run_groups_transient_execution_snapshot_check'
      AND conrelid = 'run_groups'::regclass
  ) THEN
    ALTER TABLE "run_groups"
      ADD CONSTRAINT "run_groups_transient_execution_snapshot_check"
      CHECK (
        "environment_kind" <> 'transient'
        OR "execution_snapshot" IS NOT NULL
        OR "status" = 'failed'
      ) NOT VALID;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE
      conname = 'iac_jobs_run_group_id_run_groups_id_fk'
      AND conrelid = 'iac_jobs'::regclass
      AND pg_get_constraintdef(oid) NOT LIKE '%ON DELETE CASCADE%'
  ) THEN
    ALTER TABLE "iac_jobs" DROP CONSTRAINT "iac_jobs_run_group_id_run_groups_id_fk";
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE
      conname = 'iac_jobs_run_group_id_run_groups_id_fk'
      AND conrelid = 'iac_jobs'::regclass
  ) THEN
    ALTER TABLE "iac_jobs"
      ADD CONSTRAINT "iac_jobs_run_group_id_run_groups_id_fk"
      FOREIGN KEY ("run_group_id") REFERENCES "public"."run_groups"("id") ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE
      conname = 'iac_job_history_run_group_id_run_groups_id_fk'
      AND conrelid = 'iac_job_history'::regclass
  ) THEN
    ALTER TABLE "iac_job_history"
      ADD CONSTRAINT "iac_job_history_run_group_id_run_groups_id_fk"
      FOREIGN KEY ("run_group_id") REFERENCES "public"."run_groups"("id") ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE
      conname = 'approvals_run_group_id_run_groups_id_fk'
      AND conrelid = 'approvals'::regclass
  ) THEN
    ALTER TABLE "approvals"
      ADD CONSTRAINT "approvals_run_group_id_run_groups_id_fk"
      FOREIGN KEY ("run_group_id") REFERENCES "public"."run_groups"("id");
  END IF;
END $repair$;

CREATE INDEX IF NOT EXISTS "iac_jobs_run_group_id_idx" ON "iac_jobs" USING btree ("run_group_id");
CREATE INDEX IF NOT EXISTS "iac_job_history_run_group_id_idx"
  ON "iac_job_history" USING btree ("run_group_id");
