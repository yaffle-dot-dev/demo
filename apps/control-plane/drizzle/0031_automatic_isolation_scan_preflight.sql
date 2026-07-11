ALTER TABLE "scan_jobs"
ADD COLUMN IF NOT EXISTS "automatic_isolation_workspace_paths" jsonb NOT NULL DEFAULT '[]'::jsonb;
