CREATE TYPE "public"."iac_job_status" AS ENUM('queued', 'running', 'completed', 'failed', 'system_error', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."iac_job_type" AS ENUM('plan', 'apply', 'destroy');--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" uuid,
	"description" text,
	"scopes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"created_by_flow" text,
	"token_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"preview_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"approver_login" text,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"provider_type" text,
	"credential_provider_type" text,
	"type" text NOT NULL,
	"config" jsonb NOT NULL,
	"secret_store" text,
	"secret_path" text,
	"secret_arn" text NOT NULL,
	"last_validated_at" timestamp with time zone,
	"last_validation_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"github_org_id" bigint NOT NULL,
	"github_org_login" text NOT NULL,
	"installation_id" bigint NOT NULL,
	"installation_status" text DEFAULT 'active' NOT NULL,
	"installed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installations_installation_id_unique" UNIQUE("installation_id")
);
--> statement-breakpoint
CREATE TABLE "github_repo_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"installation_id" bigint NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_repo_mappings_install_repo" UNIQUE("installation_id","github_repo_id")
);
--> statement-breakpoint
CREATE TABLE "iac_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"preview_id" uuid NOT NULL,
	"job_type" "iac_job_type" NOT NULL,
	"status" "iac_job_status" DEFAULT 'queued' NOT NULL,
	"worker_id" text,
	"last_heartbeat" timestamp with time zone,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"blocked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"result" jsonb,
	"blocked_reason" text,
	"error_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"job_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_memberships_org_user" UNIQUE("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"state_bucket" text,
	"runner_mode" text DEFAULT 'saas' NOT NULL,
	"membership_mode" text DEFAULT 'github_self_join' NOT NULL,
	"kms_key_arn" text,
	"kms_key_alias" text,
	"iam_role_arn" text,
	"provisioning_status" text DEFAULT 'pending' NOT NULL,
	"provisioning_error" text,
	"provisioning_attempts" integer DEFAULT 0 NOT NULL,
	"stripe_customer_id" text,
	"subscription_status" text DEFAULT 'none' NOT NULL,
	"plan_tier" text DEFAULT 'free' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "workspace_deployments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"run_group_id" uuid,
	"installation_id" bigint,
	"repo" text NOT NULL,
	"environment_kind" text NOT NULL,
	"environment_name" text NOT NULL,
	"pr_number" integer,
	"workspace_path" text NOT NULL,
	"ref" text NOT NULL,
	"head_sha" text NOT NULL,
	"author_github_id" bigint,
	"author_login" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"state_key" text NOT NULL,
	"mode" text NOT NULL,
	"require_approval" boolean DEFAULT false NOT NULL,
	"approvers" jsonb,
	"upstream_ids" text[] DEFAULT '{}' NOT NULL,
	"completed_upstreams" text[] DEFAULT '{}' NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "workspace_deployments_org_repo_env_workspace" UNIQUE("org_id","repo","environment_name","workspace_path")
);
--> statement-breakpoint
CREATE TABLE "provider_credential_signatures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider_type" text NOT NULL,
	"display_name" text NOT NULL,
	"suggested_credential_provider_type" text NOT NULL,
	"exact_env_vars" text[] DEFAULT '{}' NOT NULL,
	"prefix_env_vars" text[] DEFAULT '{}' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'system' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_credential_signatures_provider_type_unique" UNIQUE("provider_type")
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"installation_id" bigint,
	"github_id" bigint NOT NULL,
	"name" text NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repositories_github_id" UNIQUE("github_id")
);
--> statement-breakpoint
CREATE TABLE "run_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"repo" text NOT NULL,
	"environment_kind" text NOT NULL,
	"environment_name" text NOT NULL,
	"pr_number" integer,
	"ref" text NOT NULL,
	"head_sha" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"dependency_graph" jsonb,
	"workspace_s3_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "state_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"serial" integer NOT NULL,
	"lineage" uuid,
	"md5" text NOT NULL,
	"size" integer NOT NULL,
	"s3_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"terraform_version" text,
	"resources" jsonb,
	"outputs" jsonb,
	"resources_processed" boolean DEFAULT false NOT NULL,
	"run_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tf_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"preview_id" uuid NOT NULL,
	"run_group_id" uuid,
	"run_type" text NOT NULL,
	"status" text NOT NULL,
	"check_run_id" bigint,
	"ecs_task_arn" text,
	"plan_summary" text,
	"plan_json" jsonb,
	"log_output" text,
	"outputs" jsonb,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"repo" text NOT NULL,
	"workspace_path" text NOT NULL,
	"environment" text NOT NULL,
	"pr_number" integer,
	"ref" text NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"lock_reason" text,
	"lock_id" text,
	"current_state_version_id" uuid,
	"terraform_version" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_org_name" UNIQUE("org_id","name")
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apikey" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text DEFAULT 'default' NOT NULL,
	"name" text,
	"start" text,
	"reference_id" text NOT NULL,
	"prefix" text,
	"key" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp,
	"enabled" boolean DEFAULT true,
	"rate_limit_enabled" boolean DEFAULT true,
	"rate_limit_time_window" integer DEFAULT 86400000,
	"rate_limit_max" integer DEFAULT 10,
	"request_count" integer DEFAULT 0,
	"remaining" integer,
	"last_request" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"permissions" text,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_preview_id_workspace_deployments_id_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."workspace_deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repo_mappings" ADD CONSTRAINT "github_repo_mappings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iac_jobs" ADD CONSTRAINT "iac_jobs_preview_id_workspace_deployments_id_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."workspace_deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_deployments" ADD CONSTRAINT "workspace_deployments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_deployments" ADD CONSTRAINT "workspace_deployments_run_group_id_run_groups_id_fk" FOREIGN KEY ("run_group_id") REFERENCES "public"."run_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_groups" ADD CONSTRAINT "run_groups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "state_versions" ADD CONSTRAINT "state_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "state_versions" ADD CONSTRAINT "state_versions_run_id_tf_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."tf_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_runs" ADD CONSTRAINT "tf_runs_preview_id_workspace_deployments_id_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."workspace_deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_runs" ADD CONSTRAINT "tf_runs_run_group_id_run_groups_id_fk" FOREIGN KEY ("run_group_id") REFERENCES "public"."run_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_repo_mappings_org_id_idx" ON "github_repo_mappings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "iac_jobs_queue_priority_idx" ON "iac_jobs" USING btree ("status","job_type","queued_at");--> statement-breakpoint
CREATE INDEX "provider_credential_signatures_provider_type_idx" ON "provider_credential_signatures" USING btree ("provider_type");--> statement-breakpoint
CREATE INDEX "provider_credential_signatures_is_active_idx" ON "provider_credential_signatures" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "apikey_configId_idx" ON "apikey" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "apikey_referenceId_idx" ON "apikey" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "apikey_key_idx" ON "apikey" USING btree ("key");