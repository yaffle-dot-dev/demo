CREATE SCHEMA IF NOT EXISTS traffic_control;--> statement-breakpoint

CREATE TYPE traffic_control.routeable_deployment_state AS ENUM('active', 'inactive', 'destroyed');--> statement-breakpoint
CREATE TYPE traffic_control.routeable_deployment_receiver_kind AS ENUM('github_webhook');--> statement-breakpoint
CREATE TYPE traffic_control.live_webhook_lease_status AS ENUM('requested', 'active', 'revoking', 'revoked', 'rejected', 'error');--> statement-breakpoint
CREATE TYPE traffic_control.live_webhook_scope_class AS ENUM('repo', 'installation');--> statement-breakpoint
CREATE TYPE traffic_control.live_webhook_event AS ENUM('pull_request', 'push', 'installation_repositories');--> statement-breakpoint
CREATE TYPE traffic_control.operation_type AS ENUM('ensure_routeable_deployment', 'ensure_live_webhook_lease', 'revoke_live_webhook_lease', 'reconcile_live_webhook_lease', 'sweep_drift');--> statement-breakpoint
CREATE TYPE traffic_control.operation_status AS ENUM('accepted', 'running', 'succeeded', 'failed', 'rejected');--> statement-breakpoint

CREATE TABLE traffic_control.routeable_deployments (
	"id" uuid PRIMARY KEY NOT NULL,
	"external_deployment_id" text NOT NULL,
	"pr_number" integer NOT NULL,
	"environment_name" text NOT NULL,
	"environment_kind" text NOT NULL,
	"owner_github_user_id" bigint NOT NULL,
	"owner_github_login_snapshot" text NOT NULL,
	"receiver_url" text NOT NULL,
	"receiver_kind" traffic_control.routeable_deployment_receiver_kind DEFAULT 'github_webhook' NOT NULL,
	"state" traffic_control.routeable_deployment_state DEFAULT 'inactive' NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE traffic_control.live_webhook_leases (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" traffic_control.live_webhook_lease_status DEFAULT 'requested' NOT NULL,
	"pr_number" integer NOT NULL,
	"routeable_deployment_id" uuid NOT NULL,
	"actor_github_user_id" bigint NOT NULL,
	"actor_github_login_snapshot" text NOT NULL,
	"scope_class" traffic_control.live_webhook_scope_class NOT NULL,
	"event" traffic_control.live_webhook_event NOT NULL,
	"installation_id" bigint NOT NULL,
	"repository_id" bigint,
	"action" text,
	"pull_request_number" integer,
	"ref" text,
	"github_owner_type_snapshot" text NOT NULL,
	"github_owner_id_snapshot" bigint NOT NULL,
	"github_owner_login_snapshot" text NOT NULL,
	"reason" text NOT NULL,
	"hookdeck_destination_id" text,
	"hookdeck_destination_name" text,
	"hookdeck_connection_id" text,
	"hookdeck_connection_name" text,
	"last_reconciled_at" timestamp with time zone,
	"last_sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT tc_live_webhook_leases_scope_consistency CHECK ((("scope_class" = 'repo' AND "repository_id" IS NOT NULL) OR ("scope_class" = 'installation' AND "repository_id" IS NULL)))
);--> statement-breakpoint

CREATE TABLE traffic_control.operations (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"operation_type" traffic_control.operation_type NOT NULL,
	"status" traffic_control.operation_status DEFAULT 'accepted' NOT NULL,
	"routeable_deployment_id" uuid,
	"live_webhook_lease_id" uuid,
	"actor_github_user_id" bigint,
	"actor_github_login_snapshot" text,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"result_code" text,
	"result_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);--> statement-breakpoint

CREATE TABLE traffic_control.audit_events (
	"id" uuid PRIMARY KEY NOT NULL,
	"operation_id" uuid,
	"routeable_deployment_id" uuid,
	"live_webhook_lease_id" uuid,
	"event_type" text NOT NULL,
	"actor_github_user_id" bigint,
	"actor_github_login_snapshot" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE traffic_control.live_webhook_leases ADD CONSTRAINT tc_live_webhook_leases_routeable_deployment_id_fk FOREIGN KEY ("routeable_deployment_id") REFERENCES traffic_control.routeable_deployments("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE traffic_control.operations ADD CONSTRAINT tc_operations_routeable_deployment_id_fk FOREIGN KEY ("routeable_deployment_id") REFERENCES traffic_control.routeable_deployments("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE traffic_control.operations ADD CONSTRAINT tc_operations_live_webhook_lease_id_fk FOREIGN KEY ("live_webhook_lease_id") REFERENCES traffic_control.live_webhook_leases("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE traffic_control.audit_events ADD CONSTRAINT tc_audit_events_operation_id_fk FOREIGN KEY ("operation_id") REFERENCES traffic_control.operations("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE traffic_control.audit_events ADD CONSTRAINT tc_audit_events_routeable_deployment_id_fk FOREIGN KEY ("routeable_deployment_id") REFERENCES traffic_control.routeable_deployments("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE traffic_control.audit_events ADD CONSTRAINT tc_audit_events_live_webhook_lease_id_fk FOREIGN KEY ("live_webhook_lease_id") REFERENCES traffic_control.live_webhook_leases("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX tc_routeable_deployments_external_deployment_id_idx ON traffic_control.routeable_deployments USING btree ("external_deployment_id");--> statement-breakpoint
CREATE INDEX tc_routeable_deployments_pr_number_idx ON traffic_control.routeable_deployments USING btree ("pr_number");--> statement-breakpoint
CREATE INDEX tc_routeable_deployments_owner_github_user_id_idx ON traffic_control.routeable_deployments USING btree ("owner_github_user_id");--> statement-breakpoint
CREATE INDEX tc_routeable_deployments_state_idx ON traffic_control.routeable_deployments USING btree ("state");--> statement-breakpoint
CREATE INDEX tc_live_webhook_leases_pr_number_idx ON traffic_control.live_webhook_leases USING btree ("pr_number");--> statement-breakpoint
CREATE INDEX tc_live_webhook_leases_routeable_deployment_id_idx ON traffic_control.live_webhook_leases USING btree ("routeable_deployment_id");--> statement-breakpoint
CREATE INDEX tc_live_webhook_leases_status_idx ON traffic_control.live_webhook_leases USING btree ("status");--> statement-breakpoint
CREATE INDEX tc_live_webhook_leases_scope_lookup_idx ON traffic_control.live_webhook_leases USING btree ("status", "event", "installation_id", "repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX tc_live_webhook_leases_active_exact_scope_idx ON traffic_control.live_webhook_leases USING btree (
	"event",
	"installation_id",
	COALESCE("repository_id", (-1)::bigint),
	COALESCE("action", ''),
	COALESCE("pull_request_number", -1),
	COALESCE("ref", '')
) WHERE "status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX tc_operations_request_id_idx ON traffic_control.operations USING btree ("request_id");--> statement-breakpoint
CREATE INDEX tc_operations_status_idx ON traffic_control.operations USING btree ("status");--> statement-breakpoint
CREATE INDEX tc_operations_operation_type_idx ON traffic_control.operations USING btree ("operation_type");--> statement-breakpoint
CREATE INDEX tc_operations_live_webhook_lease_id_idx ON traffic_control.operations USING btree ("live_webhook_lease_id");--> statement-breakpoint
CREATE INDEX tc_audit_events_event_type_idx ON traffic_control.audit_events USING btree ("event_type");--> statement-breakpoint
CREATE INDEX tc_audit_events_live_webhook_lease_id_idx ON traffic_control.audit_events USING btree ("live_webhook_lease_id");--> statement-breakpoint
CREATE INDEX tc_audit_events_created_at_idx ON traffic_control.audit_events USING btree ("created_at");
