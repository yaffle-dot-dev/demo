import { Hono } from "hono"

import { requireAuth, AuthError } from "../lib/auth.ts"
import { db } from "../lib/db.ts"
import { account } from "../db/auth-schema.ts"
import { eq, and } from "drizzle-orm"

export const integrationsRoute = new Hono()

/**
 * Get the GitHub OAuth access token for the authenticated user.
 * Returns undefined if the user doesn't have a linked GitHub account.
 */
async function getGithubAccessToken(userId: string): Promise<string | undefined> {
  const rows = await db
    .select({ accessToken: account.accessToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "github")))
    .limit(1)
  return rows[0]?.accessToken ?? undefined
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

  const githubToken = await getGithubAccessToken(auth.userId)
  if (!githubToken) {
    return c.json({ error: { code: "NO_GITHUB_ACCOUNT", message: "No linked GitHub account found" } }, 400)
  }

  // Call GitHub API to list installations the user can access
  const res = await fetch("https://api.github.com/user/installations?per_page=100", {
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  })

  if (!res.ok) {
    if (res.status === 401) {
      return c.json({ error: { code: "GITHUB_TOKEN_EXPIRED", message: "GitHub access token has expired. Please sign in again." } }, 401)
    }
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

  const githubToken = await getGithubAccessToken(auth.userId)
  if (!githubToken) {
    return c.json({ error: { code: "NO_GITHUB_ACCOUNT", message: "No linked GitHub account found" } }, 400)
  }

  // GitHub API returns repos the user can access through this installation
  // This implicitly verifies the user has access to the installation
  const res = await fetch(
    `https://api.github.com/user/installations/${installationId}/repositories?per_page=100`,
    {
      headers: {
        Authorization: `token ${githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  )

  if (!res.ok) {
    if (res.status === 401) {
      return c.json({ error: { code: "GITHUB_TOKEN_EXPIRED", message: "GitHub access token has expired. Please sign in again." } }, 401)
    }
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

  const repositories = body.repositories.map((r) => ({
    githubId: r.id,
    name: r.name,
    fullName: r.full_name,
    defaultBranch: r.default_branch,
    isPrivate: r.private,
  }))

  return c.json({ data: repositories })
})
