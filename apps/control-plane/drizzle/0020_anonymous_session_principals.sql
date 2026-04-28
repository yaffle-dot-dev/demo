CREATE TABLE "principals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anonymous_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"principal_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "principal_repo_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"principal_id" uuid NOT NULL,
	"canonical_repo_namespace" text NOT NULL,
	"local_repo_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "principal_repo_bindings_unique" UNIQUE("principal_id","canonical_repo_namespace","local_repo_fingerprint")
);
--> statement-breakpoint
CREATE TABLE "hosted_output_modules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"principal_id" uuid NOT NULL,
	"repo_binding_id" uuid NOT NULL,
	"environment_name" text NOT NULL,
	"workspace_path" text NOT NULL,
	"version_serial" integer NOT NULL,
	"state_fingerprint" text NOT NULL,
	"outputs" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosted_output_modules_scope_version_unique" UNIQUE("repo_binding_id","environment_name","workspace_path","version_serial")
);
--> statement-breakpoint
ALTER TABLE "anonymous_sessions" ADD CONSTRAINT "anonymous_sessions_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal_repo_bindings" ADD CONSTRAINT "principal_repo_bindings_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_output_modules" ADD CONSTRAINT "hosted_output_modules_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_output_modules" ADD CONSTRAINT "hosted_output_modules_repo_binding_id_principal_repo_bindings_id_fk" FOREIGN KEY ("repo_binding_id") REFERENCES "public"."principal_repo_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "anonymous_sessions_principal_idx" ON "anonymous_sessions" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "principal_repo_bindings_principal_idx" ON "principal_repo_bindings" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "hosted_output_modules_scope_idx" ON "hosted_output_modules" USING btree ("repo_binding_id","environment_name","workspace_path");
