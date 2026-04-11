# Shared GitHub Org to Multiple Yaffle Orgs Plan

> Support enterprises that keep one GitHub org but split business units into separate SaaS orgs for cost allocation, compliance, and access boundaries.

## Status

Not started.

## Decision

We will hard-break the current install/org coupling model and move to explicit repo-to-org mapping.

Backwards compatibility is not a requirement. We will provide a direct migration path for our existing `yaffle-dot-dev` setup (currently one Yaffle org).

## Problem Statement

Current behavior assumes one GitHub installation/org login maps to one Yaffle org. That fails for customers with:

- one shared GitHub org
- one shared GitHub App installation
- multiple Yaffle orgs for internal BU/compliance separation

The current assumptions exist in webhook and installation lifecycle flows (for example `ensureOrg(...)` + lookup by GitHub org login), and in schema constraints that tie installation ownership to a single org.

## Goals

1. Allow multiple Yaffle orgs to operate from a single GitHub org/installation.
2. Route webhook events by repository mapping, not by GitHub org login.
3. Preserve strict tenant isolation and fail-closed behavior.
4. Add an onboarding flow that supports assigning repos to Yaffle orgs.
5. Migrate our current `yaffle-dot-dev` data safely with no ambiguity.

## Non-Goals

- rule-based auto-routing by team/path in v1
- multi-installation orchestration UX polish beyond what is needed to onboard
- compatibility with deprecated install->org auto-creation behavior

## New Tenant/Integration Model

### Core Principle

Yaffle org is the tenant boundary. GitHub installation/repositories are integration inputs.

### Data Ownership

- `organizations`: tenant boundary (authz, secrets, runs, state)
- `github_installations`: integration inventory, no tenant ownership
- `repositories`: installation/repo inventory, no tenant ownership
- `github_repo_mappings`: explicit binding from GitHub repo to Yaffle org

### Routing Rule

All PR/push webhooks resolve org via:

`(installation_id, github_repo_id) -> org_id`

If no mapping exists, ignore the event and log/audit the denial reason.

## Schema Plan

### 1) Reshape `github_installations`

Current: includes `org_id` and implies single-org ownership.

Target:

- keep: `id`, `installation_id`, `github_org_id`, `github_org_login`, `installation_status`, timestamps
- remove: `org_id`
- keep unique: `installation_id`

### 2) Reshape `repositories`

Current: includes `org_id`, unique on `github_id`.

Target:

- add/keep fields needed for inventory: `installation_id`, `github_id`, `name`, `full_name`, `default_branch`, `is_active`, timestamps
- remove: `org_id`
- uniqueness: `unique(github_id)` — GitHub repo IDs are globally unique and a repo can only belong to one installation at a time, so this is correct and simpler than a composite key.

### 3) Add `github_repo_mappings`

New table:

- `id` UUID PK
- `org_id` UUID FK -> `organizations(id)` (ON DELETE CASCADE)
- `installation_id` BIGINT FK -> `github_installations(installation_id)`
- `github_repo_id` BIGINT
- `created_by` TEXT nullable (user id for audit)
- `created_at` timestamp

Constraints:

- unique `(installation_id, github_repo_id)` to guarantee one repo maps to exactly one Yaffle org
- index on `org_id`
- index on `(installation_id, github_repo_id)`

## Query/Repository Layer Changes

### 1) Remove org creation from installation resolution

Delete/replace `ensureOrgAndInstallation(...)` and old `ensureOrg(...)` compatibility behavior that keys on GitHub org login.

### 2) Add explicit org creation

Add `POST /api/orgs` endpoint — authenticated user provides `name` (and optional `slug`). The endpoint:

- creates the org with `membershipMode: "invite_only"` (see Membership section below)
- makes the requesting user an admin (`source: "admin_bootstrap"`)
- queues the `org_provision` job (KMS key, IAM role) exactly as `ensureOrgAndInstallation` does today

Org creation is a deliberate user action, not a side effect of installing a GitHub App. This separates "give Yaffle access to my repos" (install the App) from "create a tenant boundary for my team" (create an org).

### 3) Introduce mapping-focused query helpers

Add query helpers:

- `upsertGithubInstallation(...)`
- `upsertRepositoryInventory(...)`
- `deactivateRepositoryInventory(...)`
- `findOrgForRepo(installationId, githubRepoId)`
- `setRepoMapping(orgId, installationId, githubRepoId, userId?)`
- `removeRepoMapping(installationId, githubRepoId)`
- `listRepoMappingsForOrg(orgId)`

### 4) Update repo listing queries

`findRepoByName(orgId, name)` and `listReposForOrg(orgId)` currently query `repositories` by `orgId`. After `orgId` is removed from `repositories`, these must route through the `github_repo_mappings` table to resolve which repos belong to which org.

### 5) Keep tenant-scoped data paths unchanged

No functional changes required for tables already keyed by `org_id` (`workspace_deployments`, `run_groups`, `connections`, etc.), beyond changing how org is resolved at webhook ingress.

### 6) Add `repoGithubId` to WebhookContext

The proposed routing is `(installation_id, github_repo_id) -> org_id`. `PullRequestContext` and `PushContext` (in `packages/shared/src/types.ts`) don't currently carry `repository.id`. The GitHub payload has it (`payload.repository.id`) but it's not extracted into the context in `webhooks.ts`. This must be added.

## Webhook Handling Changes

### 1) Installation events

`installation.created|deleted|suspend|unsuspend`:

- update installation inventory only
- no org auto-create
- no implicit membership bootstrap tied to installation-created
- on `installation.deleted`: cascade-delete all `github_repo_mappings` for the installation (repos from a deleted installation can't trigger runs), preserve all org-scoped historical data (`workspace_deployments`, `run_groups`, `state_versions`)

`installation_repositories.added|removed`:

- update repository inventory only
- do not infer tenant ownership

### 2) PR/push events

Before processing:

1. read `installation.id`
2. read `repository.id` (GitHub repo ID — newly extracted into context)
3. resolve mapping via `findOrgForRepo(...)`
4. if missing -> ignore fail-closed (with structured warning/audit)
5. continue with existing run/deployment logic using resolved `orgId`

### 3) Remove login-based fallback resolution

Delete any fallback path that infers org from `owner.login` or `githubOrgLogin` for execution routing.

## Admin API Changes

Add installation/repo mapping endpoints (admin-only per org):

- `GET /api/integrations/github/installations` — list installations the requesting user has access to (verified via GitHub API using stored OAuth token)
- `GET /api/integrations/github/installations/:installationId/repositories` — list repos in an installation
- `GET /api/orgs/:slug/repo-mappings`
- `POST /api/orgs/:slug/repo-mappings` (assign repo)
- `DELETE /api/orgs/:slug/repo-mappings/:installationId/:repoId` (unassign repo)

### Repo claim authorization

When creating a repo mapping, verify the requesting user has access to the GitHub installation that owns the repo:

1. Yaffle already requests `read:org` scope via GitHub OAuth.
2. `GET /api/integrations/github/installations` calls the GitHub API (`GET /user/installations`) using the user's stored OAuth access token.
3. When creating a mapping, verify the `installation_id` appears in the user's accessible installations. Reject with 403 otherwise.

Without this, any Yaffle user who knows an `installation_id` and `github_repo_id` could claim a repo for their org. The unique constraint prevents double-claiming but first-to-claim-wins is still wrong — the claimer must prove access.

### Repo unmapping

When a repo is unmapped from an org:

- Delete the mapping row (allows the repo to be remapped to a different org).
- Do NOT delete `workspace_deployments` or `run_groups` in the old org — they're historical records.
- Log an audit event: `{ action: "repo_unmapped", orgId, installationId, repoGithubId, unmappedBy }`.
- Future webhooks for this repo will be ignored (fail-closed) until it's remapped.

### Other security requirements

- only org admins can mutate mappings for that org
- mapping creation must reject conflicts (`unique(installation_id, github_repo_id)`)
- all responses redact tokens/secrets

## Membership Mode Changes

### Default to `invite_only`

New orgs default to `membershipMode: "invite_only"` instead of `"github_self_join"`. The org creator (admin) explicitly invites members.

Rationale: `github_self_join` with multiple orgs per GitHub org means every GitHub org member gets access to every Yaffle org. That defeats the purpose of splitting into multiple orgs for compliance boundaries. `invite_only` is simpler to reason about: "you're in the orgs you were invited to."

### Future `github_self_join` scoping

`github_self_join` is currently declared in the schema but not enforced (no code auto-joins users). When eventually enforced, scope it to the installation level:

- A user who is a member of GitHub org X (verified via GitHub API) can self-join any Yaffle org that has repos mapped from an installation owned by GitHub org X.
- To restrict this, the org admin switches to `invite_only`.

This is out of scope for the initial implementation.

## Onboarding Flow Changes

### Org-first model

Replace the current "install App -> poll for org -> redirect" flow with an org-first model. The GitHub App install is an inline side quest, not the entry point.

### New flow

1. **Sign up / Sign in** -> land on homepage
2. **Create org** -> user provides org name (+ optional slug). Org is created, provisioning (KMS, IAM) is queued, user becomes admin. Redirect to `/{org.slug}` dashboard (empty state).
3. **Link repos** -> user clicks "Add repositories" in the org dashboard ->
   - Yaffle calls GitHub API (`GET /user/installations`) to list installations the user has access to
   - **If the target GitHub org has the App installed:** show the repo picker. User selects repos, mappings are created.
   - **If the target GitHub org does NOT have the App installed:** inline prompt: "Yaffle needs access to this GitHub org. Install the Yaffle GitHub App ->" with a link to install. After install, `installation.created` webhook populates repo inventory. User returns to the picker and sees the repos.
4. **For returning users adding repos or creating additional orgs:** Same flow — create org, link repos. If the App is already installed on the GitHub org, jump straight to the repo picker.

### UI changes

- **Homepage "no orgs" state:** CTA becomes "Create an org" instead of "Install the GitHub App".
- **Install callback page (`/_/install/callback`):** Simplify to redirect back to the org dashboard where the user initiated the install. No polling needed — the webhook populates inventory in the background, the repo picker shows a loading state until repos appear.

### Rationale

This matches how B2B SaaS typically works (Vercel, Linear, Render): create your workspace first, then connect repos. The multi-org case works naturally — create `acme-platform` org, link repos from GitHub org `acme`; create `acme-data` org, link different repos from the same `acme` GitHub org.

## Migration Plan (Current `yaffle-dot-dev` Only)

Assumption: one existing Yaffle org and one installation context.

Because backwards compatibility is not required, we can do a direct cutover migration.

**Critical sequencing note:** Schema changes must be additive first (add new table, add columns), then destructive later (drop old columns after new code is deployed). Dropping `orgId` columns while old code is running will crash every webhook.

### Pre-migration checks

1. Verify exactly one active Yaffle org in production data.
2. Verify existing installation row(s) and repository rows are internally consistent.
3. Snapshot DB backup before migration.

### Migration steps

1. **Additive schema migration**
   - add `github_repo_mappings` table
   - add `repositories.installation_id` (nullable initially)
   - add new unique/index constraints
   - do NOT drop any existing columns

2. **Data backfill**
   - read the single existing org id (`yaffle-dot-dev` org)
   - for every repository inventory row, set `installation_id` from existing install linkage
   - insert mapping row `(org_id=<yaffle-dot-dev>, installation_id, github_repo_id)`

3. **Code cutover deployment**
   - deploy new webhook resolver using repo mappings
   - deploy new admin API/UI mapping surfaces
   - remove legacy `ensureOrg(...)` resolution path

4. **Post-migration verification**
   - synthetic PR webhook for mapped repo succeeds
   - synthetic PR webhook for unmapped repo is ignored
   - existing org dashboards still show historical data
   - no cross-tenant leakage in org-scoped endpoints

5. **Destructive schema cleanup**
   - drop `github_installations.org_id`
   - drop `repositories.org_id`
   - delete dead compatibility query/helpers
   - remove install callback UI logic that polls for "new org"

## Rollout Strategy

### PR 1 — Schema (additive only) + Query Primitives

- add `github_repo_mappings` table
- add `installation_id` column to `repositories` (nullable initially)
- add new query helpers: `findOrgForRepo()`, `setRepoMapping()`, `removeRepoMapping()`, `listRepoMappingsForOrg()`
- add `repoGithubId` to `WebhookContext` types and extract it in `webhooks.ts`
- do NOT drop any existing columns

### PR 2 — Org Creation API + Onboarding UX

- add `POST /api/orgs` endpoint (create org, queue provisioning, make creator admin)
- default new orgs to `invite_only` membership mode
- update homepage "no orgs" state: CTA becomes "Create an org" instead of "Install GitHub App"
- new org creation page/flow in the web app

### PR 3 — Installation Listing + Repo Mapping API

- add `GET /api/integrations/github/installations` (list installations user can access via GitHub API)
- add `GET /api/integrations/github/installations/:id/repositories` (list repos in an installation)
- add `POST /api/orgs/:slug/repo-mappings` (with installation membership authz check)
- add `DELETE /api/orgs/:slug/repo-mappings/:installationId/:repoId`
- add `GET /api/orgs/:slug/repo-mappings`

### PR 4 — Link Repos UX

- org dashboard: "Add repositories" flow (list installations -> pick repos -> create mappings)
- inline prompt to install GitHub App when target GitHub org doesn't have it
- simplify install callback to redirect back to org dashboard
- org settings: "Manage repo mappings" section

### PR 5 — Migration Backfill (yaffle-dot-dev)

- backfill `github_repo_mappings` for all existing repos -> single existing org
- backfill `repositories.installation_id` from existing installation
- verify via automated checks

### PR 6 — Webhook Resolution Hard Cut

- replace `ensureOrg()` calls with `findOrgForRepo(installationId, repoGithubId)`
- remove `ensureOrgAndInstallation()` and deprecated compatibility functions
- installation webhooks become pure inventory events (no org creation)
- fail closed on unmapped repos

### PR 7 — Cleanup

- drop `orgId` from `github_installations` and `repositories`
- remove deprecated query helpers
- remove old install callback polling logic

## Security Review Checklist (Required)

This change touches authz and tenant routing and requires explicit review.

- [ ] webhook ingress proves `(installation_id, github_repo_id) -> org_id`
- [ ] unmapped repos are denied/ignored (fail closed)
- [ ] mapping mutation endpoints are admin-only and org-scoped
- [ ] repo claim authz verifies user has access to the GitHub installation (via GitHub API)
- [ ] cross-org access tests pass for same GitHub org with different mapped repos
- [ ] installation deletion cascades mappings, preserves org-scoped history
- [ ] repo unmapping logs audit event, does not delete historical deployment data
- [ ] logs contain no secrets/tokens and include useful audit context

## Test Plan

### Unit tests

- mapping query helpers (insert/update/conflict/delete)
- org resolution helper behavior for mapped vs unmapped repos
- repo claim authz rejects users without installation access
- `POST /api/orgs` creates org, queues provisioning, sets admin membership

### Integration tests

Set up:

- one installation
- org A and org B
- repo X mapped to org A
- repo Y mapped to org B

Assert:

- webhook for repo X creates/updates only org A resources
- webhook for repo Y creates/updates only org B resources
- webhook for unmapped repo creates nothing
- org A user cannot read org B resources via existing org-scoped routes
- org A admin cannot map a repo from an installation they don't have access to
- installation deletion cascades mappings but preserves workspace deployments

### Migration validation tests

- run migration on seeded "single-org" fixture
- verify all existing repos are mapped to `yaffle-dot-dev`
- verify webhook processing continues for existing mapped repos

## Risks and Mitigations

- **Risk:** repos temporarily unmapped after cutover cause missed runs.
  - **Mitigation:** migration backfill (PR 5) inserts mappings for all known repos before webhook hard cut (PR 6).

- **Risk:** hidden code paths still infer org by owner/login.
  - **Mitigation:** grep-based removal checklist + test that owner/login alone cannot route.

- **Risk:** dropping `orgId` columns while old code is running crashes webhooks.
  - **Mitigation:** additive-only schema changes first; destructive cleanup only after new code is deployed (PR 7 after PR 6).

- **Risk:** unauthorized repo claiming — user maps a repo they shouldn't have access to.
  - **Mitigation:** repo mapping authz verifies user has access to the GitHub installation via GitHub API.

- **Risk:** `github_self_join` membership mode gives all GitHub org members access to all Yaffle orgs.
  - **Mitigation:** default new orgs to `invite_only`. Defer `github_self_join` enforcement to future work.

## Success Criteria

We are done when:

1. one GitHub installation can serve multiple Yaffle orgs safely.
2. repo-to-org mapping is explicit and enforceable at webhook ingress.
3. unmapped repos cannot trigger runs.
4. org creation is an explicit user action, not a webhook side effect.
5. repo claim authorization verifies the user has access to the GitHub installation.
6. `yaffle-dot-dev` migration is complete with no lost routing for existing repos.
7. onboarding flow is org-first: create org -> link repos (with inline App install when needed).
