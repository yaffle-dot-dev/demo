CREATE TABLE "environment_group_projections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"repo" text NOT NULL,
	"environment_kind" text NOT NULL,
	"environment_name" text NOT NULL,
	"source_kind" text,
	"source_metadata" jsonb,
	"status" text NOT NULL,
	"head_sha" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"workspace_count" integer DEFAULT 0 NOT NULL,
	"blocked_workspace_count" integer DEFAULT 0 NOT NULL,
	"degraded_workspace_count" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb NOT NULL,
	"rebuilt_at" timestamp with time zone NOT NULL,
	"rebuild_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_group_projections_org_repo_kind_name" UNIQUE("org_id","repo","environment_kind","environment_name")
);
--> statement-breakpoint
ALTER TABLE "environment_group_projections" ADD CONSTRAINT "environment_group_projections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "environment_group_projections_org_kind_idx" ON "environment_group_projections" USING btree ("org_id","environment_kind");--> statement-breakpoint
CREATE INDEX "environment_group_projections_org_repo_idx" ON "environment_group_projections" USING btree ("org_id","repo");