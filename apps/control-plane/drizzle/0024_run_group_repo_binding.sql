ALTER TABLE "run_groups"
ADD COLUMN "repo_binding_id" uuid REFERENCES "principal_repo_bindings"("id") ON DELETE SET NULL;
