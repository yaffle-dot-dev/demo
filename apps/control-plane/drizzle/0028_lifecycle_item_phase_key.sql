ALTER TABLE "lifecycle_items"
DROP CONSTRAINT "lifecycle_items_run_workspace_key_unique";

ALTER TABLE "lifecycle_items"
ADD CONSTRAINT "lifecycle_items_run_workspace_phase_key_unique"
UNIQUE("run_id", "workspace_path", "phase", "key");
