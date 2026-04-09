ALTER TABLE "scan_jobs"
ADD COLUMN IF NOT EXISTS "workspace_variables" jsonb;
