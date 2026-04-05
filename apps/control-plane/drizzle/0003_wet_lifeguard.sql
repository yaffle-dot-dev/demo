ALTER TABLE "approvals" RENAME COLUMN "preview_id" TO "deployment_id";--> statement-breakpoint
ALTER TABLE "iac_jobs" RENAME COLUMN "preview_id" TO "deployment_id";--> statement-breakpoint
ALTER TABLE "tf_runs" RENAME COLUMN "preview_id" TO "deployment_id";--> statement-breakpoint
ALTER TABLE "approvals" DROP CONSTRAINT "approvals_preview_id_workspace_deployments_id_fk";
--> statement-breakpoint
ALTER TABLE "iac_jobs" DROP CONSTRAINT "iac_jobs_preview_id_workspace_deployments_id_fk";
--> statement-breakpoint
ALTER TABLE "tf_runs" DROP CONSTRAINT "tf_runs_preview_id_workspace_deployments_id_fk";
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_deployment_id_workspace_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."workspace_deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iac_jobs" ADD CONSTRAINT "iac_jobs_deployment_id_workspace_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."workspace_deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_runs" ADD CONSTRAINT "tf_runs_deployment_id_workspace_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."workspace_deployments"("id") ON DELETE no action ON UPDATE no action;