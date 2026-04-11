import { Hono } from "hono"

import { requireAuth, AuthError } from "../lib/auth.ts"
import { getEnv } from "../lib/env.ts"
import { db } from "../lib/db.ts"
import { account } from "../db/auth-schema.ts"
import { eq, and } from "drizzle-orm"
import { findOrgBySlug, findOrgMembership } from "../db/queries/organizations.ts"
import { listRepoOwnersForInstallation } from "../db/queries/repo-mappings.ts"
import { listUserOrgs } from "../db/queries/users.ts"

export const integrationsRoute = new Hono()

/**
 * Get the GitHub OAuth account record for the authenticated user.
 */
async function getGithubAccount(userId: string) {
  const rows = await db
    .select({
      id: account.id,
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
    })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "github")))
    .limit(1)
  return rows[0] ?? null
}

/**
 * Refresh a GitHub OAuth token using the refresh token.
 * Updates the account record with the new tokens.
 * Returns the new access token, or null if refresh failed.
 */
async function refreshGithubToken(accountId: string, refreshToken: string): Promise<string | null> {
  const env = getEnv()

  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: env.githubOauthClientId,
      client_secret: env.githubOauthClientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  })

  if (!res.ok) return null

  const body = await res.json() as {
    access_token?: string
    refresh_token?: string
    refresh_token_expires_in?: number
    error?: string
  }

  if (body.error || !body.access_token) return null

  // Update the stored tokens
  await db
    .update(account)
    .set({
      accessToken: body.access_token,
      ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    })
    .where(eq(account.id, accountId))

  return body.access_token
}

/**
 * Get a valid GitHub access token for the user, refreshing if needed.
 */
async function getValidGithubToken(userId: string): Promise<{ token: string } | { error: string }> {
  const ghAccount = await getGithubAccount(userId)
  if (!ghAccount?.accessToken) {
    return { error: "NO_GITHUB_ACCOUNT" }
  }

  // Try the stored token first with a lightweight check
  const testRes = await fetch("https://api.github.com/user", {
    method: "HEAD",
    headers: {
      Authorization: `token ${ghAccount.accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  })

  if (testRes.ok) {
    return { token: ghAccount.accessToken }
  }

  // Token expired — try refresh
  if (testRes.status === 401 && ghAccount.refreshToken) {
    const newToken = await refreshGithubToken(ghAccount.id, ghAccount.refreshToken)
    if (newToken) {
      return { token: newToken }
    }
  }

  return { error: "GITHUB_TOKEN_EXPIRED" }
}

/**
 * GET /api/integrations/github/installations
 *
 * List GitHub App installations the current user has access to.
 * Calls GitHub API using the user's stored OAuth token.
 */
integrationsRoute.get("/github/installations", async (c) => {
  let auth
  try {
    auth = await requireAuth(c.req.raw.headers)
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.code === "AUTH_REQUIRED" ? 401 : 403
      return c.json({ error: { code: err.code, message: err.message } }, status)
    }
    throw err
  }

  const tokenResult = await getValidGithubToken(auth.userId)
  if ("error" in tokenResult) {
    const message = tokenResult.error === "NO_GITHUB_ACCOUNT"
      ? "No linked GitHub account found"
      : "GitHub access token has expired. Please sign in again."
    const status = tokenResult.error === "NO_GITHUB_ACCOUNT" ? 400 : 401
    return c.json({ error: { code: tokenResult.error, message } }, status as any)
  }

  const res = await fetch("https://api.github.com/user/installations?per_page=100", {
    headers: {
      Authorization: `token ${tokenResult.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  })

  if (!res.ok) {
    return c.json({ error: { code: "GITHUB_API_ERROR", message: `GitHub API error: ${res.status}` } }, 502)
  }

  const body = await res.json() as {
    installations: Array<{
      id: number
      account: { id: number; login: string; type: string; avatar_url: string }
      app_slug: string
    }>
  }

  // Filter to only our app's installations
  const installations = body.installations
    .filter((i) => i.app_slug === "yaffle-dot-dev")
    .map((i) => ({
      installationId: i.id,
      githubOrgId: i.account.id,
      githubOrgLogin: i.account.login,
      accountType: i.account.type,
      avatarUrl: i.account.avatar_url,
    }))

  return c.json({ data: installations })
})

/**
 * GET /api/integrations/github/installations/:id/repositories
 *
 * List repositories accessible through a GitHub App installation.
 * Verifies the user has access to this installation via GitHub API.
 */
integrationsRoute.get("/github/installations/:id/repositories", async (c) => {
  let auth
  try {
    auth = await requireAuth(c.req.raw.headers)
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.code === "AUTH_REQUIRED" ? 401 : 403
      return c.json({ error: { code: err.code, message: err.message } }, status)
    }
    throw err
  }

  const installationId = c.req.param("id")
  const orgSlug = c.req.query("org")

  const tokenResult = await getValidGithubToken(auth.userId)
  if ("error" in tokenResult) {
    const message = tokenResult.error === "NO_GITHUB_ACCOUNT"
      ? "No linked GitHub account found"
      : "GitHub access token has expired. Please sign in again."
    const status = tokenResult.error === "NO_GITHUB_ACCOUNT" ? 400 : 401
    return c.json({ error: { code: tokenResult.error, message } }, status as any)
  }

  const res = await fetch(
    `https://api.github.com/user/installations/${installationId}/repositories?per_page=100`,
    {
      headers: {
        Authorization: `token ${tokenResult.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  )

  if (!res.ok) {
    if (res.status === 403 || res.status === 404) {
      return c.json({ error: { code: "INSTALLATION_NOT_ACCESSIBLE", message: "You do not have access to this installation" } }, 403)
    }
    return c.json({ error: { code: "GITHUB_API_ERROR", message: `GitHub API error: ${res.status}` } }, 502)
  }

  const body = await res.json() as {
    repositories: Array<{
      id: number
      name: string
      full_name: string
      default_branch: string
      private: boolean
    }>
  }

  let targetOrgId: string | null = null
  let visibleOwnerSlugs = new Set<string>()

  if (orgSlug) {
    const org = await findOrgBySlug(orgSlug)
    if (!org) {
      return c.json({ error: { code: "NOT_FOUND", message: "Organization not found" } }, 404)
    }

    const membership = await findOrgMembership(org.id, auth.userId)
    if (!membership || membership.role !== "admin") {
      return c.json({ error: { code: "FORBIDDEN", message: "Admin access required" } }, 403)
    }

    targetOrgId = org.id
    const userOrgs = await listUserOrgs(auth.userId)
    visibleOwnerSlugs = new Set(userOrgs.map((entry) => entry.slug))
  }

  const repoOwners = targetOrgId
    ? await listRepoOwnersForInstallation(Number(installationId))
    : []
  const repoOwnerByGithubId = new Map(repoOwners.map((owner) => [owner.githubRepoId, owner]))

  const repositories = body.repositories.map((r) => ({
    githubId: r.id,
    name: r.name,
    fullName: r.full_name,
    defaultBranch: r.default_branch,
    isPrivate: r.private,
    mappingStatus: (() => {
      const owner = repoOwnerByGithubId.get(r.id)
      if (!owner || !targetOrgId) return "available"
      return owner.orgId === targetOrgId ? "linked_current_org" : "linked_other_org"
    })(),
    linkedOrgSlug: (() => {
      const owner = repoOwnerByGithubId.get(r.id)
      if (!owner || !targetOrgId) return null
      if (owner.orgId === targetOrgId) return orgSlug ?? owner.orgSlug
      return visibleOwnerSlugs.has(owner.orgSlug) ? owner.orgSlug : null
    })(),
  }))

  return c.json({ data: repositories })
})
