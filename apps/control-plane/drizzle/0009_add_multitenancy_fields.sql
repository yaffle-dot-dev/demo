-- Add installation tracking to organizations
ALTER TABLE organizations ADD COLUMN installation_id BIGINT;
ALTER TABLE organizations ADD COLUMN installation_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE organizations ADD COLUMN installed_at TIMESTAMP;

-- Add org_id to jobs table for tenant isolation
ALTER TABLE jobs ADD COLUMN org_id UUID NOT NULL REFERENCES organizations(id);

-- Add repositories table for tracking GitHub App repo access
CREATE TABLE repositories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  github_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT repositories_github_id UNIQUE (github_id)
);

-- Index for efficient org-scoped queries
CREATE INDEX repositories_org_id_idx ON repositories(org_id);
CREATE INDEX jobs_org_id_idx ON jobs(org_id);
