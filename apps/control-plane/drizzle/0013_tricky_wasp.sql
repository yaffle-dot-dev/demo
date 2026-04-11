CREATE TABLE "beta_access_invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text,
	"github_login" text,
	"note" text,
	"invited_by_user_id" text,
	"claimed_by_user_id" text,
	"claimed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "beta_access_invites_email_unique" UNIQUE("email"),
	CONSTRAINT "beta_access_invites_github_login_unique" UNIQUE("github_login")
);
--> statement-breakpoint
ALTER TABLE "beta_access_invites" ADD CONSTRAINT "beta_access_invites_invited_by_user_id_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beta_access_invites" ADD CONSTRAINT "beta_access_invites_claimed_by_user_id_user_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "beta_access_invites_email_idx" ON "beta_access_invites" USING btree ("email");--> statement-breakpoint
CREATE INDEX "beta_access_invites_github_login_idx" ON "beta_access_invites" USING btree ("github_login");--> statement-breakpoint
CREATE INDEX "beta_access_invites_claimed_by_user_id_idx" ON "beta_access_invites" USING btree ("claimed_by_user_id");--> statement-breakpoint
CREATE INDEX "beta_access_invites_revoked_at_idx" ON "beta_access_invites" USING btree ("revoked_at");
