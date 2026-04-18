ALTER TABLE "run_groups" ADD COLUMN "check_run_id" bigint;--> statement-breakpoint
ALTER TABLE "run_groups" ADD COLUMN "check_completed_at" timestamp with time zone;
