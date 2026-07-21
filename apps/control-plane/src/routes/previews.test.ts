import { afterAll, beforeAll, beforeEach, describe, expect, test } from "@yaffle/test"

import { Hono } from "hono"

// Import test utils FIRST to set YAFFLE_AUTH_MODE=dev before other imports
import { createTestContext, authHeaders, type TestContext } from "../test-utils/auth.ts"

import { db } from "../lib/db.ts"
import { rebuildEnvironmentGroupProjections } from "../lib/projections/environment-groups.ts"
import { createPrincipal, ensurePrincipalRepoBinding } from "../db/queries/principals.ts"
import {
  approvals,
  environmentGroupProjections,
  organizations,
  orgMemberships,
  previews,
  principalRepoBindings,
  principals,
  runGroups,
  tfRuns,
} from "../db/schema.ts"
import { previewsRoute } from "./previews.ts"

// Mount the route under /api/previews like the real app
const app = new Hono()
app.route("/api/previews", previewsRoute)

// Test context - set up once for the test suite
let ctx: TestContext

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Make an authenticated request.
 */
async function req(
  path: string,
  options: { headers?: Headers; method?: string; body?: unknown } = {},
): Promise<Response> {
  const { headers, method = "GET", body } = options
  const reqHeaders = headers ?? ctx.headers

  const init: RequestInit = {
    method,
    headers: reqHeaders,
  }

  if (body) {
    init.body = JSON.stringify(body)
    reqHeaders.set("Content-Type", "application/json")
  }

  return app.request(path, init)
}

/**
 * Make an unauthenticated request (for testing 401s).
 */
async function unauthReq(path: string): Promise<Response> {
  return app.request(path)
}

async function seedPreview(
  overrides: Partial<typeof previews.$inferInsert> = {},
): Promise<typeof previews.$inferSelect> {
  const prNumber = overrides.prNumber ?? 42
  const workspacePath = overrides.workspacePath ?? "infra"
  const environmentName = overrides.environmentName ?? `pr-${prNumber}`

  const rows = await db
    .insert(previews)
    .values({
      orgId: ctx.org.id,
      repo: overrides.repo ?? "test-repo",
      environmentKind: "transient",
      environmentName,
      prNumber,
      workspacePath,
      ref: "refs/heads/feature/test",
      headSha: "abc123",
      status: "ready",
      stateKey: `preview-pr-${prNumber}/${workspacePath}/terraform.tfstate`,
      mode: "saas",
      ...overrides,
    })
    .returning()
  return rows[0]
}

// ---------------------------------------------------------------------------
// Setup and Cleanup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Create test context with user, org, and membership
  ctx = await createTestContext({ orgSlug: "test-org" })
})

beforeEach(async () => {
  // Clean up test data between tests (but keep user/org/membership)
  await db.delete(approvals)
  await db.delete(tfRuns)
  await db.delete(environmentGroupProjections)
  await db.delete(previews)
  await db.delete(runGroups)
  await db.delete(principalRepoBindings)
  await db.delete(principals)
})

afterAll(async () => {
  // Full cleanup
  await db.delete(approvals)
  await db.delete(tfRuns)
  await db.delete(environmentGroupProjections)
  await db.delete(previews)
  await db.delete(runGroups)
  await db.delete(principalRepoBindings)
  await db.delete(principals)
  await db.delete(orgMemberships)
  await db.delete(organizations)
})

// ---------------------------------------------------------------------------
// GET /api/previews
// ---------------------------------------------------------------------------

describe("GET /api/previews", () => {
  test("returns 401 when not authenticated", async () => {
    const res = await unauthReq("/api/previews?org=test-org")
    expect(res.status).toBe(401)
  })

  test("returns 400 when org is missing", async () => {
    const res = await req("/api/previews")
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("VALIDATION_ERROR")
  })

  test("returns 404 when org does not exist", async () => {
    // Use headers with our user but request a non-existent org
    const res = await req("/api/previews?org=nonexistent")
    expect(res.status).toBe(404)
  })

  test("returns empty list when no previews exist", async () => {
    const res = await req("/api/previews?org=test-org")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual([])
    expect(body.nextCursor).toBeNull()
  })

  test("lists previews for an org", async () => {
    await seedPreview()
    await seedPreview({ prNumber: 43, stateKey: "preview-pr-43/infra/terraform.tfstate" })

    const res = await req("/api/previews?org=test-org")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(2)
    expect(body.data[0]).toHaveProperty("id")
    expect(body.data[0]).toHaveProperty("repo", "test-repo")
    expect(body.data[0]).toHaveProperty("createdAt")
    expect(body.data[0]).toHaveProperty("headUpdatedAt")
  })

  test("does not load execution context from a foreign run group", async () => {
    const [foreignOrg] = await db
      .insert(organizations)
      .values({ name: "Foreign Status Org", slug: `foreign-status-${crypto.randomUUID()}` })
      .returning()
    const [foreignRunGroup] = await db
      .insert(runGroups)
      .values({
        orgId: foreignOrg.id,
        repo: "test-repo",
        environmentKind: "transient",
        environmentName: "pr-42",
        prNumber: 42,
        ref: "refs/heads/feature/test",
        headSha: "foreign-sha",
        selectedWorkspacePaths: ["infra"],
        trigger: "pr_opened",
        executionSnapshot: {
          version: 1,
          source: {
            installationId: 1,
            repositoryId: 2,
            ownerId: 3,
            owner: "foreign-owner",
            repository: "test-repo",
            defaultBranch: "main",
            ref: "refs/heads/feature/test",
            commitSha: "foreign-sha",
            baseSha: "base-sha",
            actor: { githubId: 4, login: "octocat" },
          },
          configuration: {
            path: "yaffle.toml",
            revision: "foreign-sha",
            digest: "foreign-secret-digest",
          },
          environment: {
            kind: "transient",
            name: "pr-42",
            sourcePullRequestNumber: 42,
          },
          workspaces: [
            {
              path: "infra",
              variables: { internal_marker: "foreign-do-not-expose" },
              approval: { required: false, approvers: [] },
              lifecycle: { activation: [], verification: [] },
              outputs: {},
              automaticPreviewIsolation: false,
            },
          ],
        },
      })
      .returning()
    await seedPreview({ runGroupId: foreignRunGroup.id })

    const res = await req("/api/previews?org=test-org")
    const body = await res.json()

    expect(body.data[0].executionContext).toBeNull()
    expect(JSON.stringify(body)).not.toContain("foreign-secret-digest")
    expect(JSON.stringify(body)).not.toContain("foreign-do-not-expose")
  })

  test("serializes headUpdatedAt from status changes", async () => {
    const createdAt = new Date("2026-01-01T00:00:00Z")
    const statusChangedAt = new Date("2026-01-02T03:04:05Z")
    await seedPreview({ createdAt, statusChangedAt })

    const res = await req("/api/previews?org=test-org")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data[0].createdAt).toBe(createdAt.toISOString())
    expect(body.data[0].headUpdatedAt).toBe(statusChangedAt.toISOString())
  })

  test("filters by repo", async () => {
    await seedPreview({ repo: "repo-a" })
    await seedPreview({
      repo: "repo-b",
      prNumber: 43,
      stateKey: "previews/pr-43/infra/terraform.tfstate",
    })

    const res = await req("/api/previews?org=test-org&repo=repo-a")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].repo).toBe("repo-a")
  })

  test("filters by status", async () => {
    await seedPreview({ status: "ready" })
    await seedPreview({
      status: "failed",
      prNumber: 43,
      stateKey: "previews/pr-43/infra/terraform.tfstate",
    })

    const res = await req("/api/previews?org=test-org&status=ready")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].status).toBe("ready")
  })

  test("filters by pr_number", async () => {
    await seedPreview({ prNumber: 42 })
    await seedPreview({ prNumber: 43, stateKey: "preview-pr-43/infra/terraform.tfstate" })

    const res = await req("/api/previews?org=test-org&pr_number=42")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].prNumber).toBe(42)
  })

  test("respects limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await seedPreview({
        prNumber: i + 1,
        stateKey: `preview-pr-${i + 1}/infra/terraform.tfstate`,
      })
    }

    const res = await req("/api/previews?org=test-org&limit=2")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(2)
    expect(body.nextCursor).not.toBeNull()
  })

  test("returns 400 for invalid status", async () => {
    const res = await req("/api/previews?org=test-org&status=bogus")
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("VALIDATION_ERROR")
  })
})

describe("GET /api/previews/overview", () => {
  test("uses projected headUpdatedAt for grouped preview cards", async () => {
    const createdAt = new Date("2026-01-01T00:00:00Z")
    const statusChangedAt = new Date("2026-01-02T03:04:05Z")

    await seedPreview({
      createdAt,
      statusChangedAt,
      environmentName: "pr-42",
    })

    await rebuildEnvironmentGroupProjections({
      orgId: ctx.org.id,
      environmentKind: "transient",
    })

    const res = await req("/api/previews/overview?org=test-org")
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.data).toHaveLength(1)
    expect(body.data[0].createdAt).toBe(createdAt.toISOString())
    expect(body.data[0].headUpdatedAt).toBe(statusChangedAt.toISOString())
  })
})

// ---------------------------------------------------------------------------
// GET /api/previews/:id/approvals
// ---------------------------------------------------------------------------

describe("GET /api/previews/:id/approvals", () => {
  test("returns 404 when preview does not exist (unauthenticated)", async () => {
    // Note: returns 404 before auth check because resource doesn't exist
    const res = await unauthReq("/api/previews/00000000-0000-0000-0000-000000000000/approvals")
    expect(res.status).toBe(404)
  })

  test("returns 404 when preview does not exist (authenticated)", async () => {
    const res = await req("/api/previews/00000000-0000-0000-0000-000000000000/approvals")
    expect(res.status).toBe(404)
  })

  test("returns empty list when no approvals exist", async () => {
    const preview = await seedPreview()

    const res = await req(`/api/previews/${preview.id}/approvals`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual([])
  })

  test("returns approvals for a preview", async () => {
    const principal = await createPrincipal({ type: "anonymous_session" })
    const repoBinding = await ensurePrincipalRepoBinding({
      principalId: principal.id,
      canonicalRepoNamespace: "test-owner--test-repo",
      localRepoFingerprint: `approval-${crypto.randomUUID()}`,
    })
    const [runGroup] = await db
      .insert(runGroups)
      .values({
        orgId: ctx.org.id,
        repoBindingId: repoBinding.id,
        repo: "test-repo",
        environmentKind: "transient",
        environmentName: "pr-42",
        prNumber: 42,
        ref: "refs/heads/feature/test",
        headSha: "abc123",
        selectedWorkspacePaths: ["infra"],
        trigger: "pr_opened",
        executionSnapshot: {
          version: 1,
          source: {
            installationId: 1,
            repositoryId: 2,
            ownerId: 3,
            owner: "test-owner",
            repository: "test-repo",
            defaultBranch: "main",
            ref: "refs/heads/feature/test",
            commitSha: "abc123",
            baseSha: "base123",
            actor: { githubId: 4, login: "test-approver" },
          },
          configuration: {
            path: "yaffle.toml",
            revision: "abc123",
            digest: "config-digest",
          },
          environment: {
            kind: "transient",
            name: "pr-42",
            sourcePullRequestNumber: 42,
          },
          workspaces: [
            {
              path: "infra",
              variables: { internal_marker: "do-not-expose" },
              approval: { required: true, approvers: ["github:user:test-approver"] },
              lifecycle: {
                activation: [
                  {
                    key: "deploy",
                    environments: ["pr-42"],
                    kind: "generic",
                    failure: "failed",
                    scopes: [],
                    request: {
                      url: "https://private-hook.example.test/deploy",
                      method: "POST",
                    },
                  },
                ],
                verification: [],
              },
              outputs: {},
              automaticPreviewIsolation: false,
            },
          ],
        },
      })
      .returning()
    const preview = await seedPreview({ runGroupId: runGroup.id })

    // Seed an approval
    await db.insert(approvals).values({
      deploymentId: preview.id,
      runGroupId: runGroup.id,
      userId: ctx.user.id,
      approverLogin: "test-approver",
    })

    const res = await req(`/api/previews/${preview.id}/approvals`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toHaveProperty("id")
    expect(body.data[0]).toHaveProperty("deploymentId", preview.id)
    expect(body.data[0]).toHaveProperty("runGroupId", runGroup.id)
    expect(body.data[0]).toHaveProperty("approverLogin", "test-approver")
    expect(body.data[0].executionContext).toEqual({
      version: 1,
      commitSha: "abc123",
      configurationRevision: "abc123",
      configurationDigest: "config-digest",
    })
    expect(JSON.stringify(body)).not.toContain("do-not-expose")
    expect(JSON.stringify(body)).not.toContain("private-hook.example.test")

    const listResponse = await req("/api/previews?org=test-org")
    const listBody = await listResponse.json()
    expect(listBody.data[0].executionContext).toEqual(body.data[0].executionContext)
    expect(JSON.stringify(listBody)).not.toContain("do-not-expose")
    expect(JSON.stringify(listBody)).not.toContain("private-hook.example.test")
  })
})

// ---------------------------------------------------------------------------
// POST /api/previews/:id/approve
// ---------------------------------------------------------------------------

describe("POST /api/previews/:id/approve", () => {
  test("returns 404 when preview does not exist (unauthenticated)", async () => {
    // Note: returns 404 before auth check because resource doesn't exist
    const res = await app.request("/api/previews/00000000-0000-0000-0000-000000000000/approve", {
      method: "POST",
    })
    expect(res.status).toBe(404)
  })

  test("returns 404 when preview does not exist (authenticated)", async () => {
    const res = await req("/api/previews/00000000-0000-0000-0000-000000000000/approve", {
      method: "POST",
    })
    expect(res.status).toBe(404)
  })

  test("returns 403 when user has viewer role", async () => {
    const preview = await seedPreview({ requireApproval: true })

    // Create viewer headers
    const viewerHeaders = authHeaders({
      userId: ctx.user.id,
      email: ctx.user.email,
      orgId: ctx.org.id,
      role: "viewer",
    })

    const res = await req(`/api/previews/${preview.id}/approve`, {
      method: "POST",
      headers: viewerHeaders,
    })
    expect(res.status).toBe(403)
  })
})
