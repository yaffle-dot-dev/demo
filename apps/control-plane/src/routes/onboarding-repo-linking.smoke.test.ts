import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Hono } from "hono"

// Import test utils FIRST so dev auth is enabled before route modules load.
import { cleanupTestData, createTestUser, type TestUser } from "../test-utils/auth.ts"

import { account, user } from "../db/auth-schema.ts"
import { db } from "../lib/db.ts"
import { integrationsRoute } from "./integrations.ts"
import { orgsRoute } from "./orgs.ts"
import { repoMappingsRoute } from "./repo-mappings.ts"

process.env.STRIPE_API_KEY = ""

const app = new Hono()
app.route("/api/orgs", orgsRoute)
app.route("/api/integrations", integrationsRoute)
app.route("/api/orgs", repoMappingsRoute)

let smokeUser: TestUser
let noGithubUser: TestUser

function headersForUser(user: TestUser): Headers {
  const headers = new Headers()
  headers.set("x-yaffle-user-id", user.id)
  headers.set("x-yaffle-user-email", user.email)
  headers.set("x-yaffle-user-name", user.name)
  return headers
}

async function req(
  path: string,
  options: {
    user?: TestUser
    method?: string
    headers?: HeadersInit
    body?: unknown
  } = {},
): Promise<Response> {
  const headers = headersForUser(options.user ?? smokeUser)

  if (options.headers) {
    new Headers(options.headers).forEach((value, key) => headers.set(key, value))
  }

  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
  }

  if (options.body !== undefined) {
    headers.set("content-type", "application/json")
    init.body = JSON.stringify(options.body)
  }

  return app.request(path, init)
}

function mockGithubApi(): { calls: string[]; restore: () => void } {
  const calls: string[] = []
  const originalFetch = globalThis.fetch

  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : null
      const url = new URL(request ? request.url : String(input))
      const method = init?.method ?? request?.method ?? "GET"
      const key = `${method.toUpperCase()} ${url.pathname}${url.search}`

      calls.push(key)

      if (url.origin !== "https://api.github.com") {
        return new Response(`unexpected fetch target: ${url.origin}`, { status: 500 })
      }

      if (url.pathname === "/user" && method.toUpperCase() === "HEAD") {
        return new Response(null, { status: 200 })
      }

      if (url.pathname === "/user/installations" && method.toUpperCase() === "GET") {
        return Response.json({
          installations: [
            {
              id: 4242,
              account: {
                id: 101,
                login: "smoke-acme",
                type: "Organization",
                avatar_url: "https://example.com/smoke-acme.png",
              },
              app_slug: "yaffle-dot-dev",
            },
            {
              id: 9999,
              account: {
                id: 202,
                login: "not-ours",
                type: "Organization",
                avatar_url: "https://example.com/not-ours.png",
              },
              app_slug: "someone-elses-app",
            },
          ],
        })
      }

      if (url.pathname === "/user/installations/7777/repositories" && method.toUpperCase() === "GET") {
        return Response.json({ message: "Not Found" }, { status: 404 })
      }

      if (url.pathname === "/user/installations/4242/repositories" && method.toUpperCase() === "GET") {
        return Response.json({
          repositories: [
            {
              id: 9001,
              name: "infra",
              full_name: "smoke-acme/infra",
              default_branch: "main",
              private: true,
            },
          ],
        })
      }

      return new Response(`unexpected github api call: ${key}`, { status: 500 })
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch

  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

beforeAll(async () => {
  smokeUser = await createTestUser({ name: "Smoke Test User" })
  noGithubUser = await createTestUser({ name: "No GitHub Smoke User" })

  await db.insert(account).values({
    id: `github-account-${smokeUser.id}`,
    accountId: `github-${smokeUser.id}`,
    providerId: "github",
    userId: smokeUser.id,
    accessToken: "gho_smoke_test_token",
  })
})

beforeEach(async () => {
  await cleanupTestData()
})

afterAll(async () => {
  await cleanupTestData()
  await db.delete(user).where(eq(user.id, smokeUser.id))
  await db.delete(user).where(eq(user.id, noGithubUser.id))
})

describe("onboarding and repo linking smoke flow", () => {
  test("creates an org, discovers the GitHub installation, and links a repo", async () => {
    const { calls, restore } = mockGithubApi()
    const orgSlug = `smoke-onboarding-${crypto.randomUUID().slice(0, 8)}`

    try {
      const emptyOrgListRes = await req("/api/orgs")
      expect(emptyOrgListRes.status).toBe(200)
      const emptyOrgList = await emptyOrgListRes.json() as {
        data: Array<{ slug: string }>
      }
      expect(emptyOrgList.data).toEqual([])

      const createOrgRes = await req("/api/orgs", {
        method: "POST",
        body: {
          name: "Smoke Onboarding Org",
          slug: orgSlug,
        },
      })
      expect(createOrgRes.status).toBe(201)
      const createdOrg = await createOrgRes.json() as {
        data: { id: string; slug: string; name: string }
      }
      expect(createdOrg.data.slug).toBe(orgSlug)
      expect(createdOrg.data.name).toBe("Smoke Onboarding Org")

      const orgListRes = await req("/api/orgs")
      expect(orgListRes.status).toBe(200)
      const orgList = await orgListRes.json() as {
        data: Array<{ id: string; slug: string; role: string }>
      }
      expect(orgList.data).toHaveLength(1)
      expect(orgList.data[0]?.id).toBe(createdOrg.data.id)
      expect(orgList.data[0]?.slug).toBe(orgSlug)
      expect(orgList.data[0]?.role).toBe("admin")

      const installationsRes = await req("/api/integrations/github/installations")
      expect(installationsRes.status).toBe(200)
      const installations = await installationsRes.json() as {
        data: Array<{
          installationId: number
          githubOrgLogin: string
          accountType: string
        }>
      }
      expect(installations.data).toHaveLength(1)
      expect(installations.data[0]?.installationId).toBe(4242)
      expect(installations.data[0]?.githubOrgLogin).toBe("smoke-acme")
      expect(installations.data[0]?.accountType).toBe("Organization")

      const repositoriesRes = await req(`/api/integrations/github/installations/4242/repositories?org=${orgSlug}`)
      expect(repositoriesRes.status).toBe(200)
      const repositories = await repositoriesRes.json() as {
        data: Array<{
          githubId: number
          fullName: string
          isPrivate: boolean
          mappingStatus: string
          linkedOrgSlug: string | null
        }>
      }
      expect(repositories.data).toHaveLength(1)
      expect(repositories.data[0]?.githubId).toBe(9001)
      expect(repositories.data[0]?.fullName).toBe("smoke-acme/infra")
      expect(repositories.data[0]?.isPrivate).toBe(true)
      expect(repositories.data[0]?.mappingStatus).toBe("available")
      expect(repositories.data[0]?.linkedOrgSlug).toBeNull()

      const createMappingRes = await req(`/api/orgs/${orgSlug}/repo-mappings`, {
        method: "POST",
        body: {
          installationId: 4242,
          githubRepoId: 9001,
        },
      })
      expect(createMappingRes.status).toBe(201)
      const createdMapping = await createMappingRes.json() as {
        data: {
          orgId: string
          installationId: number
          githubRepoId: number
          createdBy: string | null
        }
      }
      expect(createdMapping.data.orgId).toBe(createdOrg.data.id)
      expect(createdMapping.data.installationId).toBe(4242)
      expect(createdMapping.data.githubRepoId).toBe(9001)
      expect(createdMapping.data.createdBy).toBe(smokeUser.id)

      const mappingsRes = await req(`/api/orgs/${orgSlug}/repo-mappings`)
      expect(mappingsRes.status).toBe(200)
      const mappings = await mappingsRes.json() as {
        data: Array<{
          installationId: number
          githubRepoId: number
          createdByName: string | null
        }>
      }
      expect(mappings.data).toHaveLength(1)
      expect(mappings.data[0]?.installationId).toBe(4242)
      expect(mappings.data[0]?.githubRepoId).toBe(9001)
      expect(mappings.data[0]?.createdByName).toBe(smokeUser.name)

      const linkedRepositoriesRes = await req(
        `/api/integrations/github/installations/4242/repositories?org=${orgSlug}`,
      )
      expect(linkedRepositoriesRes.status).toBe(200)
      const linkedRepositories = await linkedRepositoriesRes.json() as {
        data: Array<{
          githubId: number
          mappingStatus: string
          linkedOrgSlug: string | null
        }>
      }
      expect(linkedRepositories.data[0]?.githubId).toBe(9001)
      expect(linkedRepositories.data[0]?.mappingStatus).toBe("linked_current_org")
      expect(linkedRepositories.data[0]?.linkedOrgSlug).toBe(orgSlug)

      expect(calls).toEqual([
        "HEAD /user",
        "GET /user/installations?per_page=100",
        "HEAD /user",
        "GET /user/installations/4242/repositories?per_page=100",
        "GET /user/installations/4242/repositories?per_page=1",
        "HEAD /user",
        "GET /user/installations/4242/repositories?per_page=100",
      ])
    } finally {
      restore()
    }
  })

  test("fails safely for duplicate slugs, missing GitHub auth, inaccessible installs, and duplicate repo mappings", async () => {
    const noGithubAccountRes = await req("/api/integrations/github/installations", {
      user: noGithubUser,
    })
    expect(noGithubAccountRes.status).toBe(400)
    const noGithubAccountBody = await noGithubAccountRes.json() as {
      error: { code: string; message: string }
    }
    expect(noGithubAccountBody.error.code).toBe("NO_GITHUB_ACCOUNT")

    const { calls, restore } = mockGithubApi()
    const firstOrgSlug = `smoke-failure-a-${crypto.randomUUID().slice(0, 8)}`
    const secondOrgSlug = `smoke-failure-b-${crypto.randomUUID().slice(0, 8)}`

    try {
      const createOrgRes = await req("/api/orgs", {
        method: "POST",
        body: {
          name: "Failure Path Org",
          slug: firstOrgSlug,
        },
      })
      expect(createOrgRes.status).toBe(201)

      const duplicateSlugRes = await req("/api/orgs", {
        method: "POST",
        body: {
          name: "Failure Path Org Duplicate",
          slug: firstOrgSlug,
        },
      })
      expect(duplicateSlugRes.status).toBe(409)
      const duplicateSlugBody = await duplicateSlugRes.json() as {
        error: { code: string; message: string }
      }
      expect(duplicateSlugBody.error.code).toBe("SLUG_TAKEN")

      const inaccessibleInstallationRes = await req("/api/integrations/github/installations/7777/repositories")
      expect(inaccessibleInstallationRes.status).toBe(403)
      const inaccessibleInstallationBody = await inaccessibleInstallationRes.json() as {
        error: { code: string; message: string }
      }
      expect(inaccessibleInstallationBody.error.code).toBe("INSTALLATION_NOT_ACCESSIBLE")

      const inaccessibleMappingRes = await req(`/api/orgs/${firstOrgSlug}/repo-mappings`, {
        method: "POST",
        body: {
          installationId: 7777,
          githubRepoId: 7001,
        },
      })
      expect(inaccessibleMappingRes.status).toBe(403)
      const inaccessibleMappingBody = await inaccessibleMappingRes.json() as {
        error: { code: string; message: string }
      }
      expect(inaccessibleMappingBody.error.code).toBe("INSTALLATION_NOT_ACCESSIBLE")

      const secondOrgRes = await req("/api/orgs", {
        method: "POST",
        body: {
          name: "Second Failure Path Org",
          slug: secondOrgSlug,
        },
      })
      expect(secondOrgRes.status).toBe(201)

      const firstMappingRes = await req(`/api/orgs/${firstOrgSlug}/repo-mappings`, {
        method: "POST",
        body: {
          installationId: 4242,
          githubRepoId: 9001,
        },
      })
      expect(firstMappingRes.status).toBe(201)

      const repositoriesForSecondOrgRes = await req(
        `/api/integrations/github/installations/4242/repositories?org=${secondOrgSlug}`,
      )
      expect(repositoriesForSecondOrgRes.status).toBe(200)
      const repositoriesForSecondOrg = await repositoriesForSecondOrgRes.json() as {
        data: Array<{
          githubId: number
          mappingStatus: string
          linkedOrgSlug: string | null
        }>
      }
      expect(repositoriesForSecondOrg.data).toHaveLength(1)
      expect(repositoriesForSecondOrg.data[0]?.githubId).toBe(9001)
      expect(repositoriesForSecondOrg.data[0]?.mappingStatus).toBe("linked_other_org")
      expect(repositoriesForSecondOrg.data[0]?.linkedOrgSlug).toBe(firstOrgSlug)

      const duplicateMappingRes = await req(`/api/orgs/${secondOrgSlug}/repo-mappings`, {
        method: "POST",
        body: {
          installationId: 4242,
          githubRepoId: 9001,
        },
      })
      expect(duplicateMappingRes.status).toBe(409)
      const duplicateMappingBody = await duplicateMappingRes.json() as {
        error: { code: string; message: string }
      }
      expect(duplicateMappingBody.error.code).toBe("REPO_ALREADY_MAPPED")

      expect(calls).toEqual([
        "HEAD /user",
        "GET /user/installations/7777/repositories?per_page=100",
        "GET /user/installations/7777/repositories?per_page=1",
        "GET /user/installations/4242/repositories?per_page=1",
        "HEAD /user",
        "GET /user/installations/4242/repositories?per_page=100",
        "GET /user/installations/4242/repositories?per_page=1",
      ])
    } finally {
      restore()
    }
  })
})
