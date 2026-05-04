CREATE TABLE "environment_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"repo_full_name" text NOT NULL,
	"environment_name" text NOT NULL,
	"minimum_principal_tier" text NOT NULL,
	"lifecycle_dispatch" text NOT NULL,
	"allowed_destination_classes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_policies_org_repo_env_unique" UNIQUE("org_id","repo_full_name","environment_name")
);
--> statement-breakpoint
ALTER TABLE "environment_policies" ADD CONSTRAINT "environment_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "environment_policies_repo_env_idx" ON "environment_policies" USING btree ("repo_full_name","environment_name");
