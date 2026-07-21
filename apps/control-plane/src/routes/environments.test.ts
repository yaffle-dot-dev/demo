import { afterAll, beforeAll, beforeEach, describe, expect, test } from "@yaffle/test"

import { Hono } from "hono"

// Import test utils FIRST to set YAFFLE_AUTH_MODE=dev before other imports
import { createTestContext, type TestContext } from "../test-utils/auth.ts"

import { db } from "../lib/db.ts"
import { rebuildEnvironmentGroupProjections } from "../lib/projections/environment-groups.ts"
import {
  environmentGroupProjections,
  organizations,
  orgMemberships,
  previews,
  runGroups,
  tfRuns,
} from "../db/schema.ts"
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

let seedCounter = 0

async function seedProductionPreview(
  overrides: Partial<typeof previews.$inferInsert> = {},
): Promise<typeof previews.$inferSelect> {
  // Generate unique suffix for constraint-bound fields to avoid conflicts in parallel tests
  // The unique constraint is on (org_id, repo, environment_name, workspace_path)
  const counter = ++seedCounter
  const workspacePath = overrides.workspacePath ?? "infra"
  const environmentName = overrides.environmentName ?? `main-${counter}`

  const rows = await db
    .insert(previews)
    .values({
      orgId: ctx.org.id,
      repo: overrides.repo ?? "test-repo",
      environmentKind: "named",
      environmentName,
      prNumber: null,
      workspacePath,
      ref: "refs/heads/main",
      headSha: "abc123",
      status: "ready",
      stateKey: `main/${workspacePath}/terraform.tfstate`,
      mode: "terraform",
      ...overrides,
    })
    .returning()
  return rows[0]
}

async function seedRun(
  deploymentId: string,
  overrides: Partial<typeof tfRuns.$inferInsert> = {},
): Promise<typeof tfRuns.$inferSelect> {
  const rows = await db
    .insert(tfRuns)
    .values({
      deploymentId,
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
  await db.delete(environmentGroupProjections)
  await db.delete(previews)
  await db.delete(runGroups)
})

afterAll(async () => {
  // Full cleanup
  await db.delete(tfRuns)
  await db.delete(environmentGroupProjections)
  await db.delete(previews)
  await db.delete(runGroups)
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
    const res = await req("/api/environments?org=test-org&repo=test-repo")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual([])
  })

  test("returns production environments grouped by branch", async () => {
    const [runGroup] = await db
      .insert(runGroups)
      .values({
        orgId: ctx.org.id,
        repo: "test-repo",
        environmentKind: "named",
        environmentName: "main-status",
        ref: "refs/heads/main",
        headSha: "abc123",
        selectedWorkspacePaths: ["infra"],
        trigger: "push",
        executionSnapshot: {
          version: 1,
          source: {
            installationId: 1,
            repositoryId: 2,
            ownerId: 3,
            owner: "test-owner",
            repository: "test-repo",
            defaultBranch: "main",
            ref: "refs/heads/main",
            commitSha: "abc123",
            baseSha: null,
            actor: { githubId: 4, login: "octocat" },
          },
          configuration: {
            path: "yaffle.toml",
            revision: "abc123",
            digest: "environment-config-digest",
          },
          environment: {
            kind: "named",
            name: "main-status",
            sourcePullRequestNumber: null,
          },
          workspaces: [
            {
              path: "infra",
              variables: { internal_marker: "do-not-expose" },
              approval: { required: false, approvers: [] },
              lifecycle: {
                activation: [
                  {
                    key: "deploy",
                    environments: ["main-status"],
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
              automaticPreviewIsolation: false,
            },
          ],
        },
      })
      .returning()
    const preview = await seedProductionPreview({
      runGroupId: runGroup.id,
      environmentName: "main-status",
    })
    await seedRun(preview.id)

    const res = await req("/api/environments?org=test-org")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].ref).toBe("refs/heads/main")
    expect(body.data[0].repo).toBe("test-repo")
    expect(body.data[0].workspaces).toHaveLength(1)
    expect(body.data[0].workspaces[0].workspacePath).toBe("infra")
    expect(body.data[0].workspaces[0].executionContext).toEqual({
      version: 1,
      commitSha: "abc123",
      configurationRevision: "abc123",
      configurationDigest: "environment-config-digest",
    })
    expect(JSON.stringify(body)).not.toContain("do-not-expose")
    expect(JSON.stringify(body)).not.toContain("private-hook.example.test")
  })

  test("uses head update time for commit age in dag view", async () => {
    const statusChangedAt = new Date("2026-01-02T03:04:05Z")
    const preview = await seedProductionPreview({
      createdAt: new Date("2026-01-01T00:00:00Z"),
      statusChangedAt,
      environmentName: "main-dag",
    })
    await seedRun(preview.id, {
      completedAt: new Date("2026-01-03T09:10:11Z"),
    })

    await rebuildEnvironmentGroupProjections({
      orgId: ctx.org.id,
      environmentKind: "named",
    })

    const res = await req("/api/environments?org=test-org&view=dag")
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.data).toHaveLength(1)
    expect(body.data[0].updatedAt).toBe(statusChangedAt.toISOString())
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
