import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"

import { Hono } from "hono"

// Import test utils FIRST to set YAFFLE_AUTH_MODE=dev before other imports
import {
  createTestContext,
  type TestContext,
} from "../test-utils/auth.ts"

import { db } from "../lib/db.ts"
import { organizations, previews, tfRuns, orgMemberships } from "../db/schema.ts"
import { environmentsRoute } from "./environments.ts"

const app = new Hono()
app.route("/api/environments", environmentsRoute)

// Test context - set up once for the test suite
let ctx: TestContext

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Make an authenticated request.
 */
async function req(path: string): Promise<Response> {
  return app.request(path, { headers: ctx.headers })
}

/**
 * Make an unauthenticated request (for testing 401s).
 */
async function unauthReq(path: string): Promise<Response> {
  return app.request(path)
}

async function seedProductionPreview(
  overrides: Partial<typeof previews.$inferInsert> = {},
): Promise<typeof previews.$inferSelect> {
  const rows = await db
    .insert(previews)
    .values({
      orgId: ctx.org.id,
      repo: "test-repo",
      prNumber: 0,
      workspacePath: "infra",
      branch: "main",
      headSha: "abc123",
      status: "ready",
      stateKey: "main/infra/terraform.tfstate",
      mode: "terraform",
      ...overrides,
    })
    .returning()
  return rows[0]
}

async function seedRun(
  previewId: string,
  overrides: Partial<typeof tfRuns.$inferInsert> = {},
): Promise<typeof tfRuns.$inferSelect> {
  const rows = await db
    .insert(tfRuns)
    .values({
      previewId,
      runType: "apply",
      status: "success",
      planSummary: "+1, ~0, -0",
      startedAt: new Date("2026-01-01T00:00:00Z"),
      completedAt: new Date("2026-01-01T00:00:05Z"),
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
  await db.delete(tfRuns)
  await db.delete(previews)
})

afterAll(async () => {
  // Full cleanup
  await db.delete(tfRuns)
  await db.delete(previews)
  await db.delete(orgMemberships)
  await db.delete(organizations)
})

// ---------------------------------------------------------------------------
// GET /api/environments
// ---------------------------------------------------------------------------

describe("GET /api/environments", () => {
  test("returns 401 when not authenticated", async () => {
    const res = await unauthReq("/api/environments?org=test-org")
    expect(res.status).toBe(401)
  })

  test("returns 404 when org does not exist", async () => {
    const res = await req("/api/environments?org=nonexistent")
    expect(res.status).toBe(404)
  })

  test("returns empty list when no environments exist", async () => {
    const res = await req("/api/environments?org=test-org")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual([])
  })

  test("returns production environments grouped by branch", async () => {
    const preview = await seedProductionPreview()
    await seedRun(preview.id)

    const res = await req("/api/environments?org=test-org")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].branch).toBe("main")
    expect(body.data[0].repo).toBe("test-repo")
    expect(body.data[0].workspaces).toHaveLength(1)
    expect(body.data[0].workspaces[0].workspacePath).toBe("infra")
  })

  test("filters by repo", async () => {
    await seedProductionPreview({ repo: "repo-a" })
    await seedProductionPreview({ repo: "repo-b", workspacePath: "infra-b" })

    const res = await req("/api/environments?org=test-org&repo=repo-a")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].repo).toBe("repo-a")
  })
})
