CREATE TABLE IF NOT EXISTS "oauth_authorization_codes" (
  "code_hash" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "org_slug" text NOT NULL,
  "scopes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "code_challenge" text NOT NULL,
  "code_challenge_method" text NOT NULL,
  "redirect_uri" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "oauth_authorization_codes_expires_at_idx"
ON "oauth_authorization_codes" ("expires_at" ASC);
