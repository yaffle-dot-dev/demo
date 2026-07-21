# Authentication & Authorization

This document describes Yaffle's authentication system, user management, and
organization membership model.

Important: this file primarily covers account-backed web auth. Local-first CLI
auth now also uses principal credentials, anonymous sessions, and short-lived
execution tokens as described in:

- `docs/decisions/0002-local-first-principals-and-hosted-output-modules.md`
- `docs/decisions/0003-anonymous-session-abuse-quota-and-gc.md`
- `docs/decisions/0004-anonymous-session-persistence-and-repo-binding.md`

## Overview

Yaffle currently has two auth planes:

- account-backed web auth for the control plane and frontend
- principal-scoped local-first auth for CLI bootstrap, hosted output-module
  publication, and module-registry reads

Yaffle uses [BetterAuth](https://better-auth.com) for authentication with GitHub
OAuth as the identity provider. Users authenticate via GitHub, and their access
to organizations is managed through a membership system that's decoupled from
GitHub's organization model.

Local-first CLI auth is separate:

- the CLI may bootstrap an `anonymous_session` principal without a signup wall
- the CLI stores that principal locally on the machine
- the CLI exchanges it for short-lived execution tokens scoped to repo,
  environment, and consumer workspace
- execution tokens are for `yaffle.dev` module/backend auth, not general account
  sessions

### Key Concepts

- **User**: A Yaffle user, identified by BetterAuth. Can have multiple linked
  accounts (GitHub, future SSO providers).
- **Principal**: The actor used for local-first auth, quota, audit, and hosted
  output-module ownership. Principal types are `account` and
  `anonymous_session`.
- **Organization**: A Yaffle-native entity that owns previews, connections, and
  settings. Not tied 1:1 to GitHub orgs.
- **GitHub Installation**: Links a Yaffle org to a GitHub App installation,
  enabling webhooks and API access.
- **Membership**: Associates a user with an organization and defines their role.

Routes must enforce the correct auth model for their resource type. BetterAuth
session cookies and principal tokens are not interchangeable.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            BetterAuth Tables                                 │
│                                                                              │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                 │
│   │    user      │    │   account    │    │   session    │                 │
│   │              │    │              │    │              │                 │
│   │ id (TEXT)    │◄───│ provider_id, │    │ user_id,     │                 │
│   │ email, name  │    │ account_id   │    │ token,       │                 │
│   │ image        │    │ (GitHub ID)  │    │ expires_at   │                 │
│   └──────────────┘    └──────────────┘    └──────────────┘                 │
│         │                                                                    │
└─────────┼────────────────────────────────────────────────────────────────────┘
          │
          │ user_id (TEXT FK)
          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Yaffle Domain Tables                                │
│                                                                              │
│   ┌──────────────┐         ┌───────────────────┐                           │
│   │ organizations│◄────────│  org_memberships  │                           │
│   │              │         │                   │                           │
│   │ id (UUID)    │         │ org_id, user_id,  │                           │
│   │ name, slug   │         │ role, source      │                           │
│   └──────┬───────┘         └───────────────────┘                           │
│          │                                                                   │
│          │ org_id (UUID FK)                                                 │
│          ▼                                                                   │
│   ┌────────────────────┐                                                    │
│   │ github_installations│                                                   │
│   │                    │                                                    │
│   │ org_id,            │  ◄── Links Yaffle org to GitHub App installation  │
│   │ github_org_id,     │                                                    │
│   │ github_org_login,  │                                                    │
│   │ installation_id    │                                                    │
│   └────────────────────┘                                                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Why Decoupled from GitHub?

A Yaffle organization is independent from GitHub organizations. The
`github_installations` table links them. This enables:

- A possible future identity provider other than GitHub (not currently offered)
- Organizations spanning multiple GitHub orgs
- Future support for GitLab, Bitbucket, etc.

---

## Database Schema

### BetterAuth Tables

These tables are managed by BetterAuth. Schema defined in
`apps/control-plane/src/db/auth-schema.ts`.

```sql
-- User identity (provider-agnostic)
CREATE TABLE "user" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  image TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Links users to OAuth providers
CREATE TABLE "account" (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,        -- Provider's user ID (e.g., GitHub numeric ID)
  provider_id TEXT NOT NULL,       -- e.g., "github"
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  scope TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Database-backed sessions
CREATE TABLE "session" (
  id TEXT PRIMARY KEY,
  expires_at TIMESTAMP NOT NULL,
  token TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

### Yaffle Domain Tables

Defined in `apps/control-plane/src/db/schema.ts`.

```sql
-- Yaffle organizations
CREATE TABLE organizations (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  state_bucket TEXT,
  runner_mode TEXT NOT NULL DEFAULT 'saas',
  membership_mode TEXT NOT NULL DEFAULT 'github_self_join',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Links Yaffle orgs to GitHub App installations
CREATE TABLE github_installations (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  github_org_id BIGINT NOT NULL,
  github_org_login TEXT NOT NULL,
  installation_id BIGINT NOT NULL UNIQUE,
  installation_status TEXT NOT NULL DEFAULT 'active',
  installed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- User membership in organizations
CREATE TABLE org_memberships (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role TEXT NOT NULL,       -- 'viewer', 'approver', 'admin'
  source TEXT NOT NULL,     -- 'github_self_join', 'invite', 'scim', 'admin_bootstrap'
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, user_id)
);
```

---

## Roles and Permissions

| Role       | Permissions                             |
| ---------- | --------------------------------------- |
| `viewer`   | View previews, plans, logs              |
| `approver` | Viewer + approve production applies     |
| `admin`    | Approver + manage members, org settings |

Role checking uses a hierarchy:

```typescript
// apps/control-plane/src/middleware/org-auth.ts
const ROLE_HIERARCHY: Record<string, number> = {
  viewer: 1,
  approver: 2,
  admin: 3,
}

function hasMinRole(userRole: string, minRole: string): boolean {
  return (ROLE_HIERARCHY[userRole] ?? 0) >= (ROLE_HIERARCHY[minRole] ?? 0)
}
```

---

## Membership Modes

Organizations have a `membership_mode` controlling how users join:

| Mode               | Behavior                                                               |
| ------------------ | ---------------------------------------------------------------------- |
| `github_self_join` | Users can join if they're members of a linked GitHub org (default)     |
| `invite_only`      | Users must be explicitly invited by an admin                           |
| `sso_only`         | Reserved for a future SSO/SCIM implementation; not currently supported |

### Membership Sources

The `source` field on `org_memberships` records how access was granted:

| Source             | Meaning                                                             |
| ------------------ | ------------------------------------------------------------------- |
| `admin_bootstrap`  | User installed GitHub App, became first admin                       |
| `github_self_join` | User joined via GitHub org membership verification                  |
| `invite`           | User was invited by an admin                                        |
| `scim`             | Reserved source value; SCIM provisioning is not currently supported |

---

## Authentication Flow

### GitHub OAuth Sign-In

1. User clicks "Sign in with GitHub" on the frontend
2. Frontend calls `signIn.social({ provider: "github" })` via BetterAuth client
3. User is redirected to GitHub for OAuth consent
4. GitHub redirects back to `/api/auth/callback/github`
5. BetterAuth exchanges code for token, fetches user profile
6. BetterAuth creates/updates `user` and `account` records
7. BetterAuth creates `session` record and sets HTTP-only cookie
8. User is redirected to the app

### Session Verification

API requests are authenticated via session cookie:

```typescript
// apps/control-plane/src/lib/auth.ts
async function getSession(headers: Headers): Promise<Session | null> {
  return auth.api.getSession({ headers })
}

export async function requireAuth(headers: Headers): Promise<AuthContext> {
  const session = await getSession(headers)
  if (!session) {
    throw new AuthError("no valid authentication provided", "AUTH_REQUIRED")
  }
  return {
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
    // ...
  }
}
```

### Organization Access

Protected routes use the `requireOrgAccess` middleware:

```typescript
// apps/control-plane/src/middleware/org-auth.ts
previewsRoute.get(
  "/",
  requireOrgAccess({ orgSource: "query", orgKey: "org", minRole: "viewer" }),
  async (c) => {
    const auth = getAuth(c) // { userId, orgId, role, ... }
    // ...
  },
)
```

The middleware:

1. Authenticates the user via session cookie
2. Resolves the org from request (query param or path param)
3. Looks up the user's membership and role
4. Rejects if user lacks minimum required role

---

## GitHub User ID Mapping

Yaffle tracks GitHub user IDs for matching PR/push authors to Yaffle users.

### Storage

- `account.account_id` stores the GitHub user ID (as TEXT) for users who sign in
- `previews.author_github_id` stores the GitHub user ID from webhook payloads

### Lookup

```typescript
// apps/control-plane/src/db/queries/users.ts

// Find Yaffle user by their GitHub ID
export async function findUserByGithubId(githubId: string): Promise<User | undefined>

// Get GitHub ID for a Yaffle user
export async function getGithubIdForUser(userId: string): Promise<number | null>
```

### API Endpoint

The `/api/users/me` endpoint returns the current user's GitHub ID:

```typescript
// Response
{
  "data": {
    "userId": "abc123",
    "name": "Alex",
    "email": "alex@example.com",
    "githubId": 12345  // numeric GitHub user ID
  }
}
```

The frontend uses this to match "Your previews" by comparing
`preview.authorGithubId` to the current user's GitHub ID.

---

## Frontend Integration

### BetterAuth Client

```typescript
// apps/web/src/lib/auth.ts
import { createAuthClient } from "better-auth/svelte"

export const authClient = createAuthClient({
  baseURL: getApiUrl(), // Points to control plane
})

export const { signIn, signOut, useSession, getSession } = authClient
```

### Session Store

Components access session state via `useSession()`:

```svelte
<script lang="ts">
  import { useSession } from "$lib/auth"

  const session = useSession()

  // Reactive session state
  const isLoggedIn = $derived(!!$session.data?.user)
  const userName = $derived($session.data?.user?.name ?? "")
</script>
```

### SSE Authentication

Server-sent event connections use cookies via `withCredentials`:

```typescript
// apps/web/src/lib/sse/connection.ts
const es = new EventSource(url, {
  withCredentials: true, // Sends session cookie
})
```

---

## Configuration

### Control Plane Environment Variables

```bash
# BetterAuth
BETTER_AUTH_SECRET=<32+ character secret>
BETTER_AUTH_URL=http://localhost:3000

# GitHub OAuth (OAuth App, not GitHub App)
GITHUB_OAUTH_CLIENT_ID=<client id>
GITHUB_OAUTH_CLIENT_SECRET=<client secret>

# Auth mode (optional)
AUTH_MODE=production  # or "dev" for header-based auth, "off" to disable
```

### BetterAuth Configuration

```typescript
// apps/control-plane/src/lib/better-auth.ts
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
  basePath: "/api/auth",
  baseURL: env.betterAuthUrl,
  secret: env.betterAuthSecret,
  trustedOrigins: ["http://localhost:5173", "http://localhost:3000"],
  socialProviders: {
    github: {
      clientId: env.githubOauthClientId,
      clientSecret: env.githubOauthClientSecret,
      scope: ["read:user", "read:org"],
    },
  },
  session: {
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 minutes
    },
  },
})
```

---

## API Endpoints

### BetterAuth (handled by BetterAuth)

| Endpoint                       | Method | Description             |
| ------------------------------ | ------ | ----------------------- |
| `/api/auth/sign-in/social`     | POST   | Initiate OAuth flow     |
| `/api/auth/callback/:provider` | GET    | OAuth callback          |
| `/api/auth/sign-out`           | POST   | Sign out, clear session |
| `/api/auth/get-session`        | GET    | Get current session     |

### Yaffle Auth Endpoints

| Endpoint        | Method | Description                       |
| --------------- | ------ | --------------------------------- |
| `/api/users/me` | GET    | Get current user info + GitHub ID |
| `/api/orgs`     | GET    | List user's organizations         |

---

## Development Mode

When `AUTH_MODE=dev`, the control plane accepts auth via headers for testing:

```bash
curl -H "x-yaffle-user-id: test-user" \
     -H "x-yaffle-user-email: test@example.com" \
     -H "x-yaffle-org-id: test-org-id" \
     -H "x-yaffle-role: admin" \
     http://localhost:3000/api/previews?org=test-org
```

This bypasses BetterAuth session validation for local development and testing.

---

## Security Considerations

### Session Security

- Sessions stored in Postgres with cryptographically secure tokens
- Cookies are `HttpOnly`, `Secure` (in production), `SameSite=Lax`
- Session expiration enforced server-side
- Session can be revoked by deleting from database

### Cookie Configuration

BetterAuth sets session cookies with:

- `HttpOnly`: Not accessible via JavaScript
- `Secure`: HTTPS only (in production)
- `SameSite=Lax`: CSRF protection while allowing navigation

### Organization Access Control

- All org-scoped endpoints verify membership
- Role hierarchy enforced at middleware level
- Membership source tracked for audit purposes

---

## Future: SSO Support

The architecture supports adding SAML/OIDC providers via BetterAuth's SSO plugin:

1. Additional accounts link to the same user (one user, multiple providers)
2. Domain-based provider routing (e.g., `@acme.com` → Okta)
3. SCIM provisioning for automated user management
4. Organization-level SSO enforcement via `membership_mode: 'sso_only'`
