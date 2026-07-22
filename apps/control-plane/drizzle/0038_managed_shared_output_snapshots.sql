CREATE TABLE "shared_output_snapshots" (
  "id" uuid PRIMARY KEY NOT NULL,
  "publication_version" integer NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id"),
  "repo" text NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "workspace_path" text NOT NULL,
  "environment_name" text NOT NULL,
  "source_revision" text NOT NULL,
  "source_ref" text,
  "state_version_id" uuid NOT NULL REFERENCES "state_versions"("id"),
  "state_serial" integer NOT NULL,
  "state_fingerprint" text NOT NULL,
  "values" jsonb NOT NULL,
  "published_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shared_output_snapshots_scope_version_unique" UNIQUE(
    "org_id", "repository_id", "workspace_path", "environment_name", "publication_version"
  ),
  CONSTRAINT "shared_output_snapshots_state_revision_unique" UNIQUE("state_version_id", "source_revision"),
  CONSTRAINT "shared_output_snapshots_publication_version_check" CHECK("publication_version" > 0),
  CONSTRAINT "shared_output_snapshots_state_serial_check" CHECK("state_serial" >= 0)
);

CREATE INDEX "shared_output_snapshots_resolution_idx" ON "shared_output_snapshots"(
  "org_id", "repo", "workspace_path", "published_at"
);

CREATE TABLE "run_group_shared_output_bindings" (
  "id" uuid PRIMARY KEY NOT NULL,
  "run_group_id" uuid NOT NULL REFERENCES "run_groups"("id") ON DELETE CASCADE,
  "consumer_workspace_path" text NOT NULL,
  "module_name" text NOT NULL,
  "snapshot_id" uuid NOT NULL REFERENCES "shared_output_snapshots"("id"),
  "producer_org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "producer_repository_id" uuid NOT NULL REFERENCES "repositories"("id"),
  "producer_repo" text NOT NULL,
  "producer_workspace_path" text NOT NULL,
  "producer_environment_name" text NOT NULL,
  "state_version_id" uuid NOT NULL REFERENCES "state_versions"("id"),
  "state_serial" integer NOT NULL,
  "state_fingerprint" text NOT NULL,
  "source_revision" text NOT NULL,
  "output_names" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "run_group_shared_output_bindings_producer_unique" UNIQUE(
    "run_group_id", "consumer_workspace_path", "producer_repository_id", "producer_workspace_path"
  ),
  CONSTRAINT "run_group_shared_output_bindings_state_serial_check" CHECK("state_serial" >= 0)
);

CREATE INDEX "run_group_shared_output_bindings_resolution_idx" ON "run_group_shared_output_bindings"(
  "run_group_id", "consumer_workspace_path", "producer_org_id", "producer_repository_id", "producer_workspace_path"
);

CREATE FUNCTION "reject_shared_output_record_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'shared output records are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "shared_output_snapshots_immutable"
BEFORE UPDATE ON "shared_output_snapshots"
FOR EACH ROW EXECUTE FUNCTION "reject_shared_output_record_update"();

CREATE TRIGGER "run_group_shared_output_bindings_immutable"
BEFORE UPDATE ON "run_group_shared_output_bindings"
FOR EACH ROW EXECUTE FUNCTION "reject_shared_output_record_update"();
