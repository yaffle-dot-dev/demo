import { issuer } from "@openauthjs/openauth"
import { createClient } from "@openauthjs/openauth/client"
import { GithubProvider } from "@openauthjs/openauth/provider/github"
import { createSubjects } from "@openauthjs/openauth/subject"
import { MemoryStorage } from "@openauthjs/openauth/storage/memory"
import { z } from "zod"

import { getEnv } from "./env.ts"
import { ensureMembership, ensureUser } from "../db/queries/users.ts"
import { findOrgByLogin } from "../db/queries/organizations.ts"
import {
  withSpan,
  tracer,
  getGithubApiDurationHistogram,
  getGithubApiErrorCounter,
  getAuthCounter,
  getAuthDurationHistogram,
  SpanStatusCode,
  logger,
} from "./telemetry.ts"

const userSubject = z.object({
  userId: z.string(),
  login: z.string(),
  provider: z.string(),
  externalId: z.string(),
})

export const subjects = createSubjects({
  user: userSubject,
})

export function createAuthClient() {
  const env = getEnv()
  return createClient({
    clientID: env.authClientId,
    issuer: env.authIssuer,
  })
}

export function createAuthIssuer() {
  const env = getEnv()

  if (!env.githubOauthClientId || !env.githubOauthClientSecret) {
    throw new Error("missing GitHub OAuth client credentials")
  }

  return issuer({
    providers: {
      github: GithubProvider({
        clientID: env.githubOauthClientId,
        clientSecret: env.githubOauthClientSecret,
        scopes: ["read:user", "read:org"],
      }),
    },
    subjects,
    storage: MemoryStorage(),
    success: async (ctx, value) => {
      const start = Date.now()

      return tracer.startActiveSpan("auth.oauth.success", async (span) => {
        try {
          if (value.provider !== "github") {
            span.setStatus({ code: SpanStatusCode.ERROR, message: "unsupported provider" })
            span.setAttributes({ "auth.provider": value.provider })
            getAuthCounter().add(1, { operation: "oauth_success", result: "unsupported_provider" })
            span.end()
            return new Response("unsupported provider", { status: 400 })
          }

          span.setAttributes({ "auth.provider": "github" })

          const accessToken = value.tokenset.access
          const githubUser = await fetchGithubUser(accessToken)
          const orgLogins = await fetchGithubOrgs(accessToken)

          span.setAttributes({
            "github.user_id": githubUser.id,
            "github.login": githubUser.login,
            "github.org_count": orgLogins.length,
          })

          const user = await ensureUser({
            login: githubUser.login,
            provider: "github",
            externalId: String(githubUser.id),
          })

          span.setAttributes({ "auth.user_id": user.id })

          const allOrgs = new Set([githubUser.login, ...orgLogins])
          let membershipCount = 0
          for (const orgLogin of allOrgs) {
            const org = await findOrgByLogin(orgLogin)
            if (!org) continue
            const role = orgLogin === githubUser.login ? "admin" : "approver"
            await ensureMembership({
              orgId: org.id,
              userId: user.id,
              role,
            })
            membershipCount++
          }

          span.setAttributes({ "auth.membership_count": membershipCount })
          logger.info("OAuth success", {
            userId: user.id,
            login: user.login,
            membershipCount,
          })

          getAuthCounter().add(1, { operation: "oauth_success", result: "success" })
          getAuthDurationHistogram().record(Date.now() - start, { operation: "oauth_success", result: "success" })

          span.end()
          return ctx.subject("user", {
            userId: user.id,
            login: user.login,
            provider: user.provider,
            externalId: user.externalId,
          })
        } catch (err) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
          })
          span.recordException(err instanceof Error ? err : new Error(String(err)))
          getAuthCounter().add(1, { operation: "oauth_success", result: "error" })
          getAuthDurationHistogram().record(Date.now() - start, { operation: "oauth_success", result: "error" })
          span.end()
          throw err
        }
      })
    },
  })
}

async function fetchGithubUser(token: string): Promise<{ id: number; login: string }> {
  const start = Date.now()
  const endpoint = "/user"

  return withSpan("github.api.fetchUser", async (span) => {
    span.setAttributes({
      "github.endpoint": endpoint,
      "http.method": "GET",
      "http.url": "https://api.github.com/user",
    })

    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    })

    span.setAttributes({ "http.status_code": res.status })
    const duration = Date.now() - start

    if (!res.ok) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: `GitHub API error: ${res.status}` })
      getGithubApiErrorCounter().add(1, { endpoint })
      getGithubApiDurationHistogram().record(duration, { endpoint, status: String(res.status) })
      logger.error("failed to fetch GitHub user", { status: res.status, endpoint })
      throw new Error("failed to fetch GitHub user")
    }

    getGithubApiDurationHistogram().record(duration, { endpoint, status: "200" })
    const data = (await res.json()) as { id: number; login: string }
    span.setAttributes({ "github.user_id": data.id, "github.login": data.login })
    return data
  })
}

async function fetchGithubOrgs(token: string): Promise<string[]> {
  const start = Date.now()
  const endpoint = "/user/orgs"

  return withSpan("github.api.fetchOrgs", async (span) => {
    span.setAttributes({
      "github.endpoint": endpoint,
      "http.method": "GET",
      "http.url": "https://api.github.com/user/orgs",
    })

    const res = await fetch("https://api.github.com/user/orgs", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    })

    span.setAttributes({ "http.status_code": res.status })
    const duration = Date.now() - start

    if (!res.ok) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: `GitHub API error: ${res.status}` })
      getGithubApiErrorCounter().add(1, { endpoint })
      getGithubApiDurationHistogram().record(duration, { endpoint, status: String(res.status) })
      logger.warn("failed to fetch GitHub orgs", { status: res.status, endpoint })
      return []
    }

    getGithubApiDurationHistogram().record(duration, { endpoint, status: "200" })
    const data = (await res.json()) as Array<{ login: string }>
    span.setAttributes({ "github.org_count": data.length })
    return data.map((org) => org.login)
  })
}
