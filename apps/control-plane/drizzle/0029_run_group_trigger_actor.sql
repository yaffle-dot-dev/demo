ALTER TABLE "run_groups" ADD COLUMN "triggered_by_user_id" text;
ALTER TABLE "run_groups" ADD COLUMN "triggered_by_login" text;
ALTER TABLE "run_groups" ADD CONSTRAINT "run_groups_triggered_by_user_id_user_id_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
