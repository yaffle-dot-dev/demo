CREATE TABLE "iac_job_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"deployment_id" uuid NOT NULL,
	"job_type" "iac_job_type" NOT NULL,
	"status" "iac_job_status" DEFAULT 'queued' NOT NULL,
	"worker_id" text,
	"last_heartbeat" timestamp with time zone,
	"spawn_lease_token" text,
	"spawn_lease_holder" text,
	"spawn_lease_expires_at" timestamp with time zone,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"last_spawn_attempt_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"blocked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"result" jsonb,
	"blocked_reason" text,
	"error_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"spawn_attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "iac_job_history" ADD CONSTRAINT "iac_job_history_deployment_id_workspace_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."workspace_deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "iac_job_history" (
	"id",
	"deployment_id",
	"job_type",
	"status",
	"worker_id",
	"last_heartbeat",
	"spawn_lease_token",
	"spawn_lease_holder",
	"spawn_lease_expires_at",
	"queued_at",
	"dispatched_at",
	"last_spawn_attempt_at",
	"started_at",
	"blocked_at",
	"completed_at",
	"result",
	"blocked_reason",
	"error_message",
	"attempts",
	"spawn_attempts",
	"max_attempts"
)
SELECT
	"id",
	"deployment_id",
	"job_type",
	"status",
	"worker_id",
	"last_heartbeat",
	"spawn_lease_token",
	"spawn_lease_holder",
	"spawn_lease_expires_at",
	"queued_at",
	"dispatched_at",
	"last_spawn_attempt_at",
	"started_at",
	"blocked_at",
	"completed_at",
	"result",
	"blocked_reason",
	"error_message",
	"attempts",
	"spawn_attempts",
	"max_attempts"
FROM "iac_jobs"
WHERE "status" IN ('completed', 'failed', 'system_error', 'cancelled');--> statement-breakpoint
DELETE FROM "iac_jobs"
WHERE "status" IN ('completed', 'failed', 'system_error', 'cancelled');--> statement-breakpoint
CREATE INDEX "iac_job_history_deployment_queued_at_idx" ON "iac_job_history" USING btree ("deployment_id","queued_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "iac_job_history_deployment_type_queued_at_idx" ON "iac_job_history" USING btree ("deployment_id","job_type","queued_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "iac_job_history_completed_at_idx" ON "iac_job_history" USING btree ("completed_at" DESC NULLS LAST);
