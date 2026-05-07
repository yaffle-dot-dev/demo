ALTER TABLE "run_groups"
ADD COLUMN "selected_workspace_paths" jsonb NOT NULL DEFAULT '[]'::jsonb;
