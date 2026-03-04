ALTER TABLE "previews" DROP CONSTRAINT "previews_org_repo_pr";--> statement-breakpoint
ALTER TABLE "previews" ADD COLUMN "workspace_path" text NOT NULL;--> statement-breakpoint
ALTER TABLE "previews" ADD CONSTRAINT "previews_org_repo_pr_workspace" UNIQUE("org_id","repo","pr_number","workspace_path");