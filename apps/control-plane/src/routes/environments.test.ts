import { afterAll, beforeEach, describe, expect, test } from "bun:test"

import { Hono } from "hono"

import { db } from "../lib/db.ts"
import { organizations, previews, tfRuns } from "../db/schema.ts"
import { environmentsRoute } from "./environments.ts"

const app = new Hono()
app.route("/api/environments", environmentsRoute)

async function seedOrg(): Promise<string> {
  const rows = await db
    .insert(organizations)
    .values({
      name: "Test Org",
      slug: "test-org",
      stateBucket: "test-bucket",
    })
    .returning()
  return rows[0].id
}

async function seedProductionPreview(
  orgId: string,
  overrides: Partial<typeof previews.$inferInsert> = {},
): Promise<typeof previews.$inferSelect> {
  const rows = await db
    .insert(previews)
    .values({
      orgId,
      repo: "test-repo",
      prNumber: 0,
      workspacePath: "infra",
      branch: "main",
      headSha: "abc123",
      status: "ready",
      stateKey: "production/main/infra/terraform.tfstate",
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

function req(path: string): Response | Promise<Response> {
  return app.request(path)
}

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

describe("GET /api/environments", () => {
  test("returns empty list when org does not exist", async () => {
    const res = await req("/api/environments?org=missing")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual([])
  })

  test("returns production environments grouped by branch", async () => {
    const orgId = await seedOrg()
    const preview = await seedProductionPreview(orgId)
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
    const orgId = await seedOrg()
    await seedProductionPreview(orgId, { repo: "repo-a" })
    await seedProductionPreview(orgId, { repo: "repo-b", workspacePath: "infra-b" })

    const res = await req("/api/environments?org=test-org&repo=repo-a")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].repo).toBe("repo-a")
  })
})
