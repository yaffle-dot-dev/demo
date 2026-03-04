CREATE TABLE "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "login" text NOT NULL,
  "provider" text NOT NULL,
  "external_id" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "org_memberships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "role" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "org_memberships_org_user" ON "org_memberships" ("org_id", "user_id");
