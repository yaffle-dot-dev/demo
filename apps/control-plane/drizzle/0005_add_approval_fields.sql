ALTER TABLE "previews" ADD COLUMN "require_approval" boolean DEFAULT false NOT NULL;
ALTER TABLE "previews" ADD COLUMN "approvers" jsonb;
ALTER TABLE "approvals" ADD COLUMN "approver_login" text;
