# P1 Security Remediation Plan

> Close the tenant-isolation and broken-authorization gaps identified in the security audit. This is a P1 because the current TFC-compatible API can allow authenticated users to read or mutate resources outside their organization.

## Status

Not started.

## Why This Is P1

The audit found multiple control-plane paths where a valid user token is treated as globally trusted instead of org-scoped. In practice, that means a user from Org A may be able to:

- read or enumerate workspaces belonging to Org B
- read state versions or outputs for Org B
- lock, unlock, or force-unlock Org B workspaces
- create or mutate TFC-compatible resources in the wrong tenant context

This violates Yaffle's core product promise: safe multi-tenant infrastructure delivery with strong tenant isolation.

The highest-risk code paths are in:

- `apps/control-plane/src/middleware/tfc-auth.ts`
- `apps/control-plane/src/routes/tfc/workspaces.ts`
- `apps/control-plane/src/routes/tfc/state-versions.ts`
- `apps/control-plane/src/lib/auth.ts`
- `apps/control-plane/src/lib/webhook-verify.ts`

## Goals

1. Enforce tenant isolation on every authenticated TFC API path.
2. Make user tokens org-aware, least-privilege, and time-bounded.
3. Remove cross-tenant workspace and state access by ID, slug, or token.
4. Eliminate fail-open security behavior on webhook verification and similar critical paths.
5. Reduce token leakage and public-endpoint DoS exposure.
6. Add regression tests so these failures cannot quietly return.

## Non-Goals

- redesign the entire auth stack
- implement SSO/SCIM/org plugin work beyond what is required for isolation
- redesign the Terraform Cloud compatibility layer beyond security fixes
- solve every medium/low security issue in one PR if doing so delays critical tenant isolation fixes

## Audit Findings To Remediate

### Critical

1. **Cross-tenant TFC workspace access via user tokens**
   - `apps/control-plane/src/middleware/tfc-auth.ts:102`
   - `apps/control-plane/src/routes/tfc/workspaces.ts:277`
   - `apps/control-plane/src/routes/tfc/workspaces.ts:317`
   - `apps/control-plane/src/routes/tfc/workspaces.ts:437`

2. **Cross-tenant state/version/output access via user tokens**
   - `apps/control-plane/src/routes/tfc/state-versions.ts:278`
   - `apps/control-plane/src/routes/tfc/state-versions.ts:315`
   - `apps/control-plane/src/routes/tfc/state-versions.ts:391`
   - `apps/control-plane/src/routes/tfc/state-versions.ts:443`
   - `apps/control-plane/src/routes/tfc/state-versions.ts:479`

### High

3. **Any authenticated user can force-unlock any workspace**
   - `apps/control-plane/src/routes/tfc/workspaces.ts:584`
   - `apps/control-plane/src/routes/tfc/workspaces.ts:603`

4. **Webhook verification fails open if secret is unset**
   - `apps/control-plane/src/lib/webhook-verify.ts:21`

### Medium

5. **SSE accepts session/API tokens in query parameters**
   - `apps/control-plane/src/lib/auth.ts:197`
   - `apps/control-plane/src/middleware/org-auth.ts:66`

6. **Unauthenticated state upload URLs are logged and do not expire server-side**
   - `apps/control-plane/src/routes/tfc/state-versions.ts:263`
   - `apps/control-plane/src/routes/tfc/state-versions.ts:566`

7. **Public endpoints buffer entire request bodies without clear limits/rate limiting**
   - `apps/control-plane/src/routes/webhooks.ts:69`
   - `apps/control-plane/src/routes/tfc/state-versions.ts:609`
   - `apps/control-plane/src/routes/tfc/state-versions.ts:732`

## Remediation Strategy

Ship this in phases, but do not defer Phase 1. Phase 1 is the P1 containment fix and should be merged first even if later phases are still pending.

## Phase 1 - Immediate Containment

### Objective

Stop all known cross-tenant workspace/state access as quickly as possible.

### Changes

#### 1. Require org membership on all TFC organization-scoped routes

Apply `requireOrgMembership(...)` to every TFC route that resolves an org from path params.

At minimum:

- `GET /tfc/api/v2/organizations/:org_name/workspaces`
- `GET /tfc/api/v2/organizations/:org_name/workspaces/:name`
- `POST /tfc/api/v2/organizations/:org_name/workspaces`
- any future org-scoped TFC routes added later

Implementation approach:

- use `requireOrgMembership(async (c) => (await findOrgBySlug(c.req.param("org_name")))?.id ?? "")`
- return `404` when org does not exist
- return `403` when token is valid but membership is missing
- enforce role requirements explicitly for mutating routes

#### 2. Require workspace-level tenant checks on all TFC workspace-by-id routes

For routes using `:workspace_id`, fetch the workspace first and verify:

- run tokens: `auth.workspaceId === ws.id` and `auth.orgId === ws.orgId`
- user tokens: caller is a member of `ws.orgId`

At minimum:

- `GET /tfc/api/v2/workspaces/:workspace_id`
- `POST /tfc/api/v2/workspaces/:workspace_id/actions/lock`
- `POST /tfc/api/v2/workspaces/:workspace_id/actions/unlock`
- `POST /tfc/api/v2/workspaces/:workspace_id/actions/force-unlock`
- `POST /tfc/api/v2/workspaces/:workspace_id/state-versions`
- `GET /tfc/api/v2/workspaces/:workspace_id/current-state-version`
- `GET /tfc/api/v2/workspaces/:workspace_id/current-state-version-outputs`

Create and use a shared helper instead of repeating ad hoc checks. Example shape:

```ts
interface TfcWorkspaceAccess {
  workspace: Workspace
  auth: TfcAuthContext
  role?: "viewer" | "approver" | "admin"
}

async function requireTfcWorkspaceAccess(...): Promise<TfcWorkspaceAccess>
```

#### 3. Require state-version tenant checks on all state-version-by-id routes

For `:state_version_id` routes, fetch the state version, then fetch its workspace, then verify tenant membership against the workspace org.

At minimum:

- `GET /tfc/api/v2/state-versions`
- `GET /tfc/api/v2/state-versions/:state_version_id`
- `GET /tfc/api/v2/state-versions/:state_version_id/download`

Important detail:

- `GET /tfc/api/v2/state-versions` currently accepts `filter[workspace][id]`; this is effectively an IDOR if user tokens are not tenant-checked.
- listing must verify that the caller belongs to the org owning that workspace before returning any rows.

#### 4. Lock down force-unlock immediately

Change `POST /tfc/api/v2/workspaces/:workspace_id/actions/force-unlock` so that:

- run tokens are always forbidden
- user tokens require org membership with `admin` role on the workspace's org
- the action is audit-logged with user id, org id, workspace id, previous locker

This endpoint should be treated as a privileged break-glass action.

### Acceptance Criteria

- a user token from Org A cannot list workspaces in Org B
- a user token from Org A cannot fetch a workspace by ID from Org B
- a user token from Org A cannot read state versions, downloads, or outputs from Org B
- a non-admin user cannot force-unlock any workspace
- all TFC workspace/state tests include cross-tenant negative cases

## Phase 2 - Token Model Hardening

### Objective

Replace the current globally powerful TFC user-token behavior with org-scoped, least-privilege semantics.

### Current Problem

`apps/control-plane/src/middleware/tfc-auth.ts:102` sets user tokens to `scopes: ["*"]`.

That is too broad for a multi-tenant system because:

- tenant access becomes dependent on every route remembering to re-check org membership
- leaked tokens have very high blast radius
- auditability is poor because token intent is not encoded

### Design

Introduce explicit token metadata in `api_tokens`:

- `org_id` nullable for legacy/global tokens during migration
- `scope_set` or normalized scopes field
- `expires_at` required for newly issued CLI tokens
- `created_by_flow` (`terraform_login`, `ui_manual`, `service`, etc.)

Recommended scope model:

- `workspace:read`
- `workspace:write`
- `workspace:lock`
- `state:read`
- `state:write`
- `state:download`
- `admin:force_unlock`

Recommended org model:

- user TFC tokens should be bound to exactly one org
- users with access to multiple orgs should mint separate tokens per org
- Terraform login flow should make org selection explicit

### Implementation Steps

#### 1. Extend schema

Update `apps/control-plane/src/db/schema.ts` and corresponding Drizzle migration to add:

```ts
orgId: uuid("org_id").references(() => organizations.id)
scopes: text("scopes").array().notNull().default(sql`ARRAY[]::text[]`)
createdByFlow: text("created_by_flow")
```

If the existing schema already has analogous fields, normalize to one canonical representation instead of duplicating.

#### 2. Update token issuance flow

Update `apps/control-plane/src/routes/tfc/oauth-cli.ts` so `terraform login` token issuance:

- requires selecting or specifying an org
- stores that org on the token record
- assigns a bounded scope set
- sets an expiration by default

Recommended default expiration:

- 30 days for CLI tokens
- optionally shorter for preview/testing environments

#### 3. Update token auth middleware

Update `apps/control-plane/src/middleware/tfc-auth.ts` so authenticated user context includes:

- `userId`
- `orgId`
- explicit scopes from DB
- possibly token id for audit logging

Do not synthesize `*` for normal user tokens.

#### 4. Migrate legacy tokens safely

Migration approach:

- existing tokens continue to work only behind strict route-level org membership checks
- mark legacy tokens as needing rotation in UI/API
- provide a limited migration window
- after the window, revoke or refuse legacy global tokens

### Acceptance Criteria

- no newly issued user token has global cross-org reach
- all newly issued CLI tokens expire automatically
- route auth can rely on token org scoping as defense in depth, not sole enforcement
- legacy token behavior is documented and time-boxed

## Phase 3 - Query Token and Session Transport Hardening

### Objective

Stop leaking auth tokens through URLs and remove support for using Better Auth session tokens outside their intended transport.

### Current Problem

`requireAuth()` currently accepts:

- API keys in query params
- Better Auth session tokens in query params
- Better Auth session tokens through `Authorization: Bearer ...`

This is risky because URL-based tokens leak into:

- access logs
- browser history
- copy/paste flows
- referrer headers
- reverse proxies and traces

### Changes

#### 1. Remove query-param session token support

In `apps/control-plane/src/lib/auth.ts`:

- do not accept Better Auth session tokens from `options.token`
- if query tokens remain temporarily supported, only allow dedicated short-lived SSE tokens, not full session tokens

#### 2. Keep browser SSE on cookies

The web app already uses cookie-backed SSE in `apps/web/src/lib/sse/index.svelte.ts:89`.

Preserve that model and make it the only browser path.

#### 3. If non-browser SSE needs token auth, add dedicated stream tokens

If there is a real CLI/non-browser SSE use case, add a dedicated stream token with:

- short TTL, e.g. 5 minutes
- org/resource scoping
- single-purpose scope such as `stream:read`
- no reuse as a session token or general API token

### Acceptance Criteria

- query strings are no longer accepted for Better Auth session auth
- SSE browser paths authenticate through cookies only
- no general-purpose API token is required in a URL

## Phase 4 - Webhook and Public Endpoint Hardening

### Objective

Remove fail-open behavior and reduce external abuse surface on public endpoints.

### Changes

#### 1. Fail closed on webhook secret misconfiguration

Update `apps/control-plane/src/lib/webhook-verify.ts`:

- if `GITHUB_WEBHOOK_SECRET` is unset, reject verification
- if a developer bypass is needed locally, require an explicit env var such as `YAFFLE_ALLOW_INSECURE_WEBHOOKS=true`
- log loudly when the insecure bypass is used

Recommended behavior:

```ts
if (!secret) {
  if (process.env.YAFFLE_ALLOW_INSECURE_WEBHOOKS === "true") {
    logger.warn("insecure webhook verification bypass enabled")
    return
  }
  throw new WebhookVerificationError("webhook secret not configured")
}
```

#### 2. Add body-size limits

Add explicit request size limits for:

- `/api/webhooks/github`
- `/tfc/api/v2/state-versions/:id/upload`
- `/tfc/api/v2/state-versions/:id/upload-json`
- OAuth form/json endpoints where appropriate

Implementation options:

- Hono middleware that checks `content-length`
- streamed readers with a hard byte cap when `content-length` is missing or dishonest

Recommended initial limits:

- GitHub webhooks: 1 MB
- JSON state upload: 10 MB
- raw state upload: choose based on real Terraform state expectations, but still bounded

#### 3. Add rate limits to public endpoints

Add IP-based rate limiting for:

- `/api/webhooks/github`
- `/tfc/api/v2/state-versions/:id/upload`
- `/tfc/api/v2/state-versions/:id/upload-json`
- `/tfc/oauth/*`

This can be in-app initially, but should eventually align with edge/ALB/WAF protections if those are introduced.

### Acceptance Criteria

- webhook verification never silently succeeds without a configured secret unless an explicit insecure dev override is set
- oversized upload/webhook bodies are rejected before full buffering
- noisy abusive traffic is rate-limited on public endpoints

## Phase 5 - State Upload Capability Hardening

### Objective

Preserve TFC compatibility while making upload URLs safer.

### Current Problem

The upload endpoint is intentionally unauthenticated, but today it is protected mainly by possession of the UUID state-version id. That is acceptable only if the capability is short-lived, one-time-use, and never widely exposed.

Current gaps:

- upload URL is logged
- no server-side age check for pending uploads
- no explicit max pending age cleanup tied to security semantics

### Changes

#### 1. Stop logging capability URLs

Remove `uploadUrl` from logs in `apps/control-plane/src/routes/tfc/state-versions.ts:263`.

Only log:

- stateVersionId
- workspaceId
- serial

#### 2. Enforce pending-upload TTL

When handling unauthenticated upload:

- reject pending state versions older than a short TTL, e.g. 15 minutes
- mark expired pending versions as `discarded`

Suggested rule:

- upload valid only while `status === "pending"` and `createdAt >= now - 15m`

#### 3. Consider stronger capability tokens if needed

If UUID-only capability control still feels too weak, consider adding a signed upload token in addition to the state-version id. Do this only if it does not break Terraform compatibility.

### Acceptance Criteria

- pending upload URLs expire server-side
- upload URLs are not emitted to logs
- stale pending uploads cannot be replayed indefinitely

## Phase 6 - Logging, Audit, and Safe Error Handling

### Objective

Make sensitive operations auditable without leaking secrets or capability tokens.

### Changes

#### 1. Audit sensitive admin/security actions

Add structured logs for:

- force-unlock
- token issuance and revocation
- failed cross-tenant access attempts
- webhook verification failures
- state upload expiry and replay attempts

#### 2. Avoid logging secrets, session tokens, capability URLs, or raw auth headers

Review logging in:

- `apps/control-plane/src/routes/tfc/state-versions.ts`
- `apps/control-plane/src/routes/tfc/workspaces.ts`
- `apps/control-plane/src/routes/tfc/oauth-cli.ts`
- `apps/control-plane/src/routes/webhooks.ts`

#### 3. Standardize security error responses

Avoid returning overly helpful details in places where it creates oracle behavior. Examples:

- cross-tenant resource access should prefer `404` or generic `403` based on product/API semantics
- do not reveal whether another tenant's resource exists unless needed for protocol compatibility

### Acceptance Criteria

- sensitive security events have audit logs
- secrets and capability tokens do not appear in normal logs
- authorization failures are consistent across TFC endpoints

## Phase 7 - Test and Verification Plan

### Unit Tests

Add or expand tests for:

- `apps/control-plane/src/middleware/tfc-auth.ts`
- `apps/control-plane/src/routes/tfc/workspaces.ts`
- `apps/control-plane/src/routes/tfc/state-versions.ts`
- `apps/control-plane/src/lib/webhook-verify.ts`
- `apps/control-plane/src/lib/auth.ts`

Required cases:

- user token from wrong org denied on org-scoped route
- user token from wrong org denied on workspace-id route
- user token from wrong org denied on state-version-id route
- non-admin denied on force-unlock
- admin from correct org allowed on force-unlock
- pending upload older than TTL denied
- webhook verification fails when secret missing
- query-param session token rejected

### Integration Tests

Create end-to-end TFC API tests that set up:

- Org A, User A, Workspace A, State A
- Org B, User B, Workspace B, State B

Then assert:

- User A cannot access Org B resources by slug
- User A cannot access Org B resources by workspace ID
- User A cannot access Org B resources by state version ID
- User A cannot force-unlock Workspace B

### Manual Verification Checklist

1. Run `bun test` for affected packages.
2. Run targeted TFC integration tests.
3. Verify `terraform login` still works after token model changes.
4. Verify Terraform state upload/download flows still work with expiry logic.
5. Verify browser SSE still functions using cookies only.
6. Verify webhook handling in local/dev with both secure and explicit insecure-dev modes.

## Rollout Plan

### PR 1 - Containment

- strict tenant checks on TFC routes
- admin-only force-unlock
- tests for cross-tenant denial

This is the must-merge-first PR.

### PR 2 - Webhook and public endpoint hardening

- fail-closed webhook verification
- body-size limits
- rate limiting scaffold
- stop logging upload URLs

### PR 3 - Token model hardening

- org-scoped TFC user tokens
- expirations
- migration path for legacy tokens

### PR 4 - SSE/query token cleanup

- remove query-param session auth
- add dedicated stream token only if truly necessary

### PR 5 - Follow-up observability and cleanup

- audit logs
- docs
- token rotation UX / migration support

## Ownership

### Control Plane

- `apps/control-plane/src/middleware/tfc-auth.ts`
- `apps/control-plane/src/routes/tfc/workspaces.ts`
- `apps/control-plane/src/routes/tfc/state-versions.ts`
- `apps/control-plane/src/routes/tfc/oauth-cli.ts`
- `apps/control-plane/src/lib/auth.ts`
- `apps/control-plane/src/lib/webhook-verify.ts`

### Infrastructure / Platform

- edge or in-app rate limiting choice
- any ALB/WAF follow-up
- production secret/config validation for webhook secret and auth settings

### Web

- ensure SSE continues to rely on cookies
- support org-scoped token UX if CLI token creation surfaces in UI later

## Success Criteria

We are done when all of the following are true:

- tenant isolation holds for TFC workspace and state APIs even when callers know other tenants' IDs
- no authenticated user can perform cross-tenant mutations
- no non-admin can force-unlock a workspace
- webhook auth cannot silently fail open in production
- public upload/webhook endpoints have bounded abuse surface
- token leakage via query params is eliminated or restricted to narrowly scoped short-lived capability tokens
- regression tests cover the original findings

## Future Follow-Ups

- add formal threat modeling for tenant isolation boundaries
- add security-focused CI checks for authz coverage on new TFC routes
- consider WAF or edge protections for public upload/webhook endpoints
- add explicit audit-event storage if structured logs are not sufficient
- review whether module registry signed archive tokens need similar expiry/logging hardening
