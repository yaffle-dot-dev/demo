ALTER TABLE "lifecycle_runs"
ADD COLUMN "run_group_id" uuid REFERENCES "run_groups"("id") ON DELETE SET NULL;

CREATE INDEX "lifecycle_runs_run_group_idx"
ON "lifecycle_runs" ("run_group_id");
