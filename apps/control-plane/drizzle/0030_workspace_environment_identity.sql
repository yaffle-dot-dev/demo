ALTER TABLE "workspaces" ADD COLUMN "environment_kind" text;
ALTER TABLE "workspaces" ADD COLUMN "environment_name" text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "workspaces"
    WHERE "environment" = 'preview' AND "pr_number" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot migrate preview workspace without GitHub PR source metadata';
  END IF;
END $$;

UPDATE "workspaces"
SET
  "environment_kind" = CASE
    WHEN "environment" = 'preview' THEN 'transient'
    ELSE 'named'
  END,
  "environment_name" = CASE
    WHEN "environment" = 'preview' AND "pr_number" IS NOT NULL THEN 'pr-' || "pr_number"::text
    ELSE "environment"
  END;

ALTER TABLE "workspaces" ALTER COLUMN "environment_kind" SET NOT NULL;
ALTER TABLE "workspaces" ALTER COLUMN "environment_name" SET NOT NULL;
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_environment_kind_check"
  CHECK ("environment_kind" IN ('named', 'transient'));
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_environment_name_check"
  CHECK (length(btrim("environment_name")) > 0);
ALTER TABLE "workspace_deployments" ADD CONSTRAINT "workspace_deployments_environment_kind_check"
  CHECK ("environment_kind" IN ('named', 'transient'));
ALTER TABLE "run_groups" ADD CONSTRAINT "run_groups_environment_kind_check"
  CHECK ("environment_kind" IN ('named', 'transient'));

ALTER TABLE "workspaces" DROP COLUMN "environment";
ALTER TABLE "workspaces" DROP COLUMN "pr_number";

ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_environment_identity_unique" UNIQUE (
  "org_id",
  "repo",
  "workspace_path",
  "environment_kind",
  "environment_name"
);
