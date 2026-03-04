import { afterAll, beforeEach, describe, expect, test } from "bun:test"

import { Hono } from "hono"

import { db } from "../lib/db.ts"
import { organizations, previews, tfRuns } from "../db/schema.ts"
import { runsRoute } from "./runs.ts"

// Mount the route under /api/runs like the real app
const app = new Hono()
app.route("/api/runs", runsRoute)

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

async function seedPreview(orgId: string): Promise<string> {
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
    })
    .returning()
  return rows[0].id
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
// GET /api/runs/:id
// ---------------------------------------------------------------------------

describe("GET /api/runs/:id", () => {
  test("returns 400 for non-UUID id", async () => {
    const res = await req("/api/runs/not-a-uuid")
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("VALIDATION_ERROR")
  })

  test("returns 404 when run does not exist", async () => {
    const res = await req("/api/runs/00000000-0000-0000-0000-000000000000")
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe("RUN_NOT_FOUND")
  })

  test("returns run detail with duration", async () => {
    const orgId = await seedOrg()
    const previewId = await seedPreview(orgId)
    const run = await seedRun(previewId, {
      runType: "plan",
      status: "success",
      planSummary: "+2, ~1, -0",
    })

    const res = await req(`/api/runs/${run.id}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.id).toBe(run.id)
    expect(body.data.previewId).toBe(previewId)
    expect(body.data.runType).toBe("plan")
    expect(body.data.status).toBe("success")
    expect(body.data.planSummary).toBe("+2, ~1, -0")
    expect(body.data.durationMs).toBe(5000)
    expect(body.data.startedAt).toBeDefined()
    expect(body.data.completedAt).toBeDefined()
    expect(body.data.createdAt).toBeDefined()
  })

  test("returns null durationMs when timing is missing", async () => {
    const orgId = await seedOrg()
    const previewId = await seedPreview(orgId)
    const run = await seedRun(previewId, {
      startedAt: null,
      completedAt: null,
    })

    const res = await req(`/api/runs/${run.id}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.durationMs).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// GET /api/runs/:id/plan
// ---------------------------------------------------------------------------

describe("GET /api/runs/:id/plan", () => {
  test("returns 404 when run does not exist", async () => {
    const res = await req("/api/runs/00000000-0000-0000-0000-000000000000/plan")
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe("RUN_NOT_FOUND")
  })

  test("returns 404 when no plan JSON available", async () => {
    const orgId = await seedOrg()
    const previewId = await seedPreview(orgId)
    const run = await seedRun(previewId, { planJson: null })

    const res = await req(`/api/runs/${run.id}/plan`)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe("NO_PLAN")
  })

  test("returns plan JSON", async () => {
    const orgId = await seedOrg()
    const previewId = await seedPreview(orgId)
    const planData = {
      format_version: "1.2",
      resource_changes: [
        { address: "aws_instance.web", change: { actions: ["create"] } },
      ],
    }
    const run = await seedRun(previewId, { planJson: planData })

    const res = await req(`/api/runs/${run.id}/plan`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual(planData)
  })
})

// ---------------------------------------------------------------------------
// GET /api/runs/:id/output
// ---------------------------------------------------------------------------

describe("GET /api/runs/:id/output", () => {
  test("returns 404 when run does not exist", async () => {
    const res = await req("/api/runs/00000000-0000-0000-0000-000000000000/output")
    expect(res.status).toBe(404)
  })

  test("returns error message as plain text when run failed", async () => {
    const orgId = await seedOrg()
    const previewId = await seedPreview(orgId)
    const run = await seedRun(previewId, {
      status: "failed",
      errorMessage: "Error: resource not found",
      planSummary: null,
    })

    const res = await req(`/api/runs/${run.id}/output`)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toBe("Error: resource not found")
  })

  test("returns plan summary as plain text", async () => {
    const orgId = await seedOrg()
    const previewId = await seedPreview(orgId)
    const run = await seedRun(previewId, {
      status: "success",
      planSummary: "+3, ~1, -0",
      errorMessage: null,
    })

    const res = await req(`/api/runs/${run.id}/output`)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toBe("+3, ~1, -0")
  })

  test("returns empty string when no output available", async () => {
    const orgId = await seedOrg()
    const previewId = await seedPreview(orgId)
    const run = await seedRun(previewId, {
      planSummary: null,
      errorMessage: null,
    })

    const res = await req(`/api/runs/${run.id}/output`)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toBe("")
  })
})
