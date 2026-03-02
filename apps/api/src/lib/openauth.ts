import { issuer } from "@openauthjs/openauth"
import { createClient } from "@openauthjs/openauth/client"
import { GithubProvider } from "@openauthjs/openauth/provider/github"
import { createSubjects } from "@openauthjs/openauth/subject"
import { MemoryStorage } from "@openauthjs/openauth/storage/memory"
import { z } from "zod"

import { getEnv } from "./env.ts"
import { ensureMembership, ensureUser } from "../db/queries/users.ts"
import { findOrgByLogin } from "../db/queries/organizations.ts"

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
      if (value.provider !== "github") {
        return new Response("unsupported provider", { status: 400 })
      }

      const accessToken = value.tokenset.access
      const githubUser = await fetchGithubUser(accessToken)
      const orgLogins = await fetchGithubOrgs(accessToken)

      const user = await ensureUser({
        login: githubUser.login,
        provider: "github",
        externalId: String(githubUser.id),
      })

      const allOrgs = new Set([githubUser.login, ...orgLogins])
      for (const orgLogin of allOrgs) {
        const org = await findOrgByLogin(orgLogin)
        if (!org) continue
        const role = orgLogin === githubUser.login ? "admin" : "approver"
        await ensureMembership({
          orgId: org.id,
          userId: user.id,
          role,
        })
      }

      return ctx.subject("user", {
        userId: user.id,
        login: user.login,
        provider: user.provider,
        externalId: user.externalId,
      })
    },
  })
}

async function fetchGithubUser(token: string): Promise<{ id: number; login: string }> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  })
  if (!res.ok) {
    throw new Error("failed to fetch GitHub user")
  }
  const data = (await res.json()) as { id: number; login: string }
  return data
}

async function fetchGithubOrgs(token: string): Promise<string[]> {
  const res = await fetch("https://api.github.com/user/orgs", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  })
  if (!res.ok) return []
  const data = (await res.json()) as Array<{ login: string }>
  return data.map((org) => org.login)
}
