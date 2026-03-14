import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"

import { Hono } from "hono"

// Import test utils FIRST to set YAFFLE_AUTH_MODE=dev before other imports
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../test-utils/auth.ts"

import { db } from "../lib/db.ts"
import { organizations, previews, tfRuns, orgMemberships, approvals } from "../db/schema.ts"
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

let seedCounter = 0

async function seedPreview(
  overrides: Partial<typeof previews.$inferInsert> = {},
): Promise<typeof previews.$inferSelect> {
  // Generate unique suffix for constraint-bound fields to avoid conflicts in parallel tests
  // The unique constraint is on (org_id, repo, environment_name, workspace_path)
  const counter = ++seedCounter
  const prNumber = overrides.prNumber ?? 42
  const workspacePath = overrides.workspacePath ?? "infra"
  const environmentName = overrides.environmentName ?? `pr-${prNumber}-${counter}`
  
  const rows = await db
    .insert(previews)
    .values({
      orgId: ctx.org.id,
      repo: overrides.repo ?? "test-repo",
      environmentKind: "transient",
      environmentName,
      prNumber,
      workspacePath,
      branch: "feature/test",
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
  await db.delete(previews)
})

afterAll(async () => {
  // Full cleanup
  await db.delete(approvals)
  await db.delete(tfRuns)
  await db.delete(previews)
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
  })

  test("filters by repo", async () => {
    await seedPreview({ repo: "repo-a" })
    await seedPreview({ repo: "repo-b", prNumber: 43, stateKey: "previews/pr-43/infra/terraform.tfstate" })

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
    const preview = await seedPreview()
    
    // Seed an approval
    await db.insert(approvals).values({
      deploymentId: preview.id,
      userId: ctx.user.id,
      approverLogin: "test-approver",
    })

    const res = await req(`/api/previews/${preview.id}/approvals`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toHaveProperty("id")
    expect(body.data[0]).toHaveProperty("deploymentId", preview.id)
    expect(body.data[0]).toHaveProperty("approverLogin", "test-approver")
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
