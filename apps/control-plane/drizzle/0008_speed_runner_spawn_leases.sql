ALTER TABLE "iac_jobs"
ADD COLUMN IF NOT EXISTS "spawn_lease_token" text,
ADD COLUMN IF NOT EXISTS "spawn_lease_holder" text,
ADD COLUMN IF NOT EXISTS "spawn_lease_expires_at" timestamp with time zone,
ADD COLUMN IF NOT EXISTS "last_spawn_attempt_at" timestamp with time zone,
ADD COLUMN IF NOT EXISTS "spawn_attempts" integer DEFAULT 0 NOT NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "iac_jobs_spawn_lease_idx" ON "iac_jobs" ("status", "spawn_lease_expires_at");
