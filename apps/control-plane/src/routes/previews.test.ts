import { afterAll, beforeEach, describe, expect, test } from "bun:test"

import { Hono } from "hono"

import { db } from "../lib/db.ts"
import { organizations, previews, tfRuns } from "../db/schema.ts"
import { previewsRoute } from "./previews.ts"

// Mount the route under /api/previews like the real app
const app = new Hono()
app.route("/api/previews", previewsRoute)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedOrg(): Promise<string> {
  const rows = await db
    .insert(organizations)
    .values({
      githubId: 99999,
      login: "test-org",
      stateBucket: "test-bucket",
    })
    .returning()
  return rows[0].id
}

async function seedPreview(
  orgId: string,
  overrides: Partial<typeof previews.$inferInsert> = {},
): Promise<typeof previews.$inferSelect> {
  const rows = await db
    .insert(previews)
    .values({
      orgId,
      repo: "test-repo",
      prNumber: 42,
      workspacePath: "infra",
      branch: "feature/test",
      headSha: "abc123",
      status: "ready",
      stateKey: "previews/pr-42/infra/terraform.tfstate",
      mode: "saas",
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
      runType: "plan",
      status: "success",
      planSummary: "+1, ~0, -0",
      startedAt: new Date("2026-01-01T00:00:00Z"),
      completedAt: new Date("2026-01-01T00:00:05Z"),
      ...overrides,
    })
    .returning()
  return rows[0]
}

function req(path: string): Response | Promise<Response> {
  return app.request(path)
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await db.delete(tfRuns)
  await db.delete(previews)
  await db.delete(organizations)
})

afterAll(async () => {
  await db.delete(tfRuns)
  await db.delete(previews)
  await db.delete(organizations)
})

// ---------------------------------------------------------------------------
// GET /api/previews
// ---------------------------------------------------------------------------

describe("GET /api/previews", () => {
  test("returns 400 when org is missing", async () => {
    const res = await req("/api/previews")
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("VALIDATION_ERROR")
  })

  test("returns empty list when org does not exist", async () => {
    const res = await req("/api/previews?org=nonexistent")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual([])
    expect(body.nextCursor).toBeNull()
  })

  test("returns empty list when no previews exist", async () => {
    await seedOrg()
    const res = await req("/api/previews?org=test-org")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual([])
    expect(body.nextCursor).toBeNull()
  })

  test("lists previews for an org", async () => {
    const orgId = await seedOrg()
    await seedPreview(orgId)
    await seedPreview(orgId, { prNumber: 43, stateKey: "previews/pr-43/infra/terraform.tfstate" })

    const res = await req("/api/previews?org=test-org")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(2)
    expect(body.data[0]).toHaveProperty("id")
    expect(body.data[0]).toHaveProperty("repo", "test-repo")
    expect(body.data[0]).toHaveProperty("createdAt")
  })

  test("filters by repo", async () => {
    const orgId = await seedOrg()
    await seedPreview(orgId, { repo: "repo-a" })
    await seedPreview(orgId, { repo: "repo-b", prNumber: 43, stateKey: "previews/pr-43/infra/terraform.tfstate" })

    const res = await req("/api/previews?org=test-org&repo=repo-a")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].repo).toBe("repo-a")
  })

  test("filters by status", async () => {
    const orgId = await seedOrg()
    await seedPreview(orgId, { status: "ready" })
    await seedPreview(orgId, {
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
    const orgId = await seedOrg()
    await seedPreview(orgId, { prNumber: 42 })
    await seedPreview(orgId, { prNumber: 43, stateKey: "previews/pr-43/infra/terraform.tfstate" })

    const res = await req("/api/previews?org=test-org&pr_number=42")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].prNumber).toBe(42)
  })

  test("respects limit parameter", async () => {
    const orgId = await seedOrg()
    for (let i = 0; i < 5; i++) {
      await seedPreview(orgId, {
        prNumber: i + 1,
        stateKey: `previews/pr-${i + 1}/infra/terraform.tfstate`,
      })
    }

    const res = await req("/api/previews?org=test-org&limit=2")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(2)
    expect(body.nextCursor).not.toBeNull()
  })

  test("returns 400 for invalid status", async () => {
    await seedOrg()
    const res = await req("/api/previews?org=test-org&status=bogus")
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("VALIDATION_ERROR")
  })
})

// ---------------------------------------------------------------------------
// GET /api/previews/:id
// ---------------------------------------------------------------------------

describe("GET /api/previews/:id", () => {
  test("returns 400 for non-UUID id", async () => {
    const res = await req("/api/previews/not-a-uuid")
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("VALIDATION_ERROR")
  })

  test("returns 404 when preview does not exist", async () => {
    const res = await req("/api/previews/00000000-0000-0000-0000-000000000000")
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe("PREVIEW_NOT_FOUND")
  })

  test("returns preview detail", async () => {
    const orgId = await seedOrg()
    const preview = await seedPreview(orgId)

    const res = await req(`/api/previews/${preview.id}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.id).toBe(preview.id)
    expect(body.data.repo).toBe("test-repo")
    expect(body.data.prNumber).toBe(42)
    expect(body.data.workspacePath).toBe("infra")
    expect(body.data.status).toBe("ready")
    expect(body.data.createdAt).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// GET /api/previews/:id/runs
// ---------------------------------------------------------------------------

describe("GET /api/previews/:id/runs", () => {
  test("returns 404 when preview does not exist", async () => {
    const res = await req("/api/previews/00000000-0000-0000-0000-000000000000/runs")
    expect(res.status).toBe(404)
  })

  test("returns empty list when no runs exist", async () => {
    const orgId = await seedOrg()
    const preview = await seedPreview(orgId)

    const res = await req(`/api/previews/${preview.id}/runs`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual([])
  })

  test("lists runs for a preview", async () => {
    const orgId = await seedOrg()
    const preview = await seedPreview(orgId)
    await seedRun(preview.id, { runType: "plan", status: "success" })
    await seedRun(preview.id, { runType: "apply", status: "success" })

    const res = await req(`/api/previews/${preview.id}/runs`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(2)
    expect(body.data[0]).toHaveProperty("id")
    expect(body.data[0]).toHaveProperty("runType")
    expect(body.data[0]).toHaveProperty("status")
    expect(body.data[0]).toHaveProperty("createdAt")
  })
})

// ---------------------------------------------------------------------------
// GET /api/previews/:id/outputs
// ---------------------------------------------------------------------------

describe("GET /api/previews/:id/outputs", () => {
  test("returns 404 when preview does not exist", async () => {
    const res = await req("/api/previews/00000000-0000-0000-0000-000000000000/outputs")
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe("PREVIEW_NOT_FOUND")
  })

  test("returns 404 when no successful apply exists", async () => {
    const orgId = await seedOrg()
    const preview = await seedPreview(orgId)
    // Only a plan run, no apply
    await seedRun(preview.id, { runType: "plan", status: "success" })

    const res = await req(`/api/previews/${preview.id}/outputs`)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe("NO_OUTPUTS")
  })

  test("returns 404 when apply failed", async () => {
    const orgId = await seedOrg()
    const preview = await seedPreview(orgId)
    await seedRun(preview.id, { runType: "apply", status: "failed", outputs: null })

    const res = await req(`/api/previews/${preview.id}/outputs`)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe("NO_OUTPUTS")
  })

  test("returns outputs from latest successful apply", async () => {
    const orgId = await seedOrg()
    const preview = await seedPreview(orgId)
    const outputs = { cluster_arn: { value: "arn:aws:ecs:us-east-1:123:cluster/test" } }
    await seedRun(preview.id, {
      runType: "apply",
      status: "success",
      outputs,
    })

    const res = await req(`/api/previews/${preview.id}/outputs`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual(outputs)
  })
})
