CREATE TABLE "warm_runner_sessions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "worker_id" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "max_slots" integer DEFAULT 1 NOT NULL,
  "active_slots" integer DEFAULT 0 NOT NULL,
  "metadata" jsonb,
  "last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_claimed_at" timestamp with time zone,
  "last_idle_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "warm_runner_sessions_worker_id" ON "warm_runner_sessions" ("worker_id");
CREATE INDEX "warm_runner_sessions_org_status_idx" ON "warm_runner_sessions" ("org_id", "status", "last_heartbeat_at");
