ALTER TABLE "hosted_output_modules"
ADD COLUMN "canonical_repo_namespace" text;

UPDATE "hosted_output_modules" AS hm
SET "canonical_repo_namespace" = prb."canonical_repo_namespace"
FROM "principal_repo_bindings" AS prb
WHERE hm."repo_binding_id" = prb."id";

ALTER TABLE "hosted_output_modules"
ALTER COLUMN "canonical_repo_namespace" SET NOT NULL;

ALTER TABLE "hosted_output_modules"
ALTER COLUMN "principal_id" DROP NOT NULL;

ALTER TABLE "hosted_output_modules"
ALTER COLUMN "repo_binding_id" DROP NOT NULL;

ALTER TABLE "hosted_output_modules"
DROP CONSTRAINT "hosted_output_modules_scope_version_unique";

DROP INDEX IF EXISTS "hosted_output_modules_scope_idx";

ALTER TABLE "hosted_output_modules"
ADD CONSTRAINT "hosted_output_modules_scope_version_unique"
UNIQUE("canonical_repo_namespace", "environment_name", "workspace_path", "version_serial");

CREATE INDEX "hosted_output_modules_scope_idx"
ON "hosted_output_modules" ("canonical_repo_namespace", "environment_name", "workspace_path");
