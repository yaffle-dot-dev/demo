import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { db } from "../lib/db.ts"
import { ensureAccountPrincipal } from "../db/queries/principals.ts"
import { updateOrg } from "../db/queries/organizations.ts"
import { parseYaffleToml } from "../lib/config-toml.ts"
import { generateAccountPrincipalToken } from "../lib/principal-tokens.ts"
import { repositories } from "../db/schema.ts"
import { addMembership, cleanupTestData, createTestOrg, createTestUser } from "../test-utils/auth.ts"

import { createCloudConvergeRoute } from "./cloud-converge.ts"

const TEST_FEATURE_TOKEN = "test-feature-token"

describe("cloudConvergeRoute", () => {
  beforeEach(() => {
    process.env.YAFFLE_LOCAL_FIRST_FEATURE_TOKEN = TEST_FEATURE_TOKEN
  })

  afterEach(async () => {
    delete process.env.YAFFLE_LOCAL_FIRST_FEATURE_TOKEN
    await cleanupTestData()
  })

  test("creates a hosted manual run group for a paid-cloud approver", async () => {
    const user = await createTestUser({ id: "remote-converge-user" })
    const org = await createTestOrg({ slug: "remote-converge-org" })
    await addMembership(org.id, user.id, "approver")
    await updateOrg(org.id, {
      planTier: "pro",
      subscriptionStatus: "active",
    })
    await db.insert(repositories).values({
      orgId: org.id,
      githubId: 12345,
      name: "fixture",
      fullName: "test-org/fixture",
      defaultBranch: "main",
      installationId: 67890,
      isActive: true,
    })

    const principal = await ensureAccountPrincipal({ userId: user.id })
    const token = await generateAccountPrincipalToken({
      principalId: principal.id,
      userId: user.id,
    })

    const seen: {
      installationId?: number
      scan?: { runGroupId: string; workspacePaths: string[]; installationToken: string }
    } = {}
    const app = new Hono()
    app.route("/api/cloud", createCloudConvergeRoute({
      loadConfig: async () => parseYaffleToml(`
version = 1

[cloud.triggers.github]
push = [{ environment = "main", ref_patterns = ["refs/heads/main"] }]

[[workspaces]]
path = "apps/control-plane/infra"
environments = ["main"]

[[workspaces]]
path = "apps/web/infra"
environments = ["main"]
`),
      loadInstallationToken: async (installationId) => {
        seen.installationId = installationId
        return "installation-token"
      },
      scanDispatcher: async (input) => {
        seen.scan = {
          runGroupId: input.runGroupId,
          workspacePaths: input.workspacePaths,
          installationToken: input.installationToken,
        }
        return { scanJobId: "scan-job-1" }
      },
    }))

    const response = await app.fetch(new Request("http://localhost/api/cloud/converge", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "feature-token": TEST_FEATURE_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        repoFullName: "test-org/fixture",
        environmentName: "main",
        ref: "refs/heads/main",
        headSha: "abc123def456",
        workspacePaths: ["apps/control-plane/infra"],
      }),
    }))

    expect(response.status).toBe(202)
    const body = await response.json() as {
      data: { runGroupId: string; scanJobId: string; workspacePaths: string[]; status: string }
    }
    expect(body.data.scanJobId).toBe("scan-job-1")
    expect(body.data.workspacePaths).toEqual(["apps/control-plane/infra"])
    expect(body.data.status).toBe("queued")
    expect(seen.installationId).toBe(67890)
    expect(seen.scan?.workspacePaths).toEqual(["apps/control-plane/infra"])
    expect(seen.scan?.installationToken).toBe("installation-token")

    const runGroup = await db.query.runGroups.findFirst({
      where: (runGroups, { eq }) => eq(runGroups.id, body.data.runGroupId),
    })
    expect(runGroup?.trigger).toBe("manual")
    expect(runGroup?.environmentName).toBe("main")
    expect(runGroup?.ref).toBe("refs/heads/main")
    expect(seen.scan?.runGroupId).toBe(body.data.runGroupId)
  })

  test("rejects users without paid-cloud entitlement", async () => {
    const user = await createTestUser({ id: "remote-converge-free-user" })
    const org = await createTestOrg({ slug: "remote-converge-free-org" })
    await addMembership(org.id, user.id, "approver")
    await db.insert(repositories).values({
      orgId: org.id,
      githubId: 54321,
      name: "fixture",
      fullName: "test-org/fixture",
      defaultBranch: "main",
      installationId: 67890,
      isActive: true,
    })

    const principal = await ensureAccountPrincipal({ userId: user.id })
    const token = await generateAccountPrincipalToken({
      principalId: principal.id,
      userId: user.id,
    })

    const app = new Hono()
    app.route("/api/cloud", createCloudConvergeRoute({
      loadConfig: async () => parseYaffleToml(`version = 1`),
      loadInstallationToken: async () => "installation-token",
      scanDispatcher: async () => ({ scanJobId: "scan-job-1" }),
    }))

    const response = await app.fetch(new Request("http://localhost/api/cloud/converge", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "feature-token": TEST_FEATURE_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        repoFullName: "test-org/fixture",
        environmentName: "main",
        ref: "refs/heads/main",
        headSha: "abc123def456",
        workspacePaths: ["apps/control-plane/infra"],
      }),
    }))

    expect(response.status).toBe(403)
    const body = await response.json() as { error: { code: string } }
    expect(body.error.code).toBe("PAID_CLOUD_REQUIRED")
  })

  test("rejects invalid workspace selections", async () => {
    const user = await createTestUser({ id: "remote-converge-selection-user" })
    const org = await createTestOrg({ slug: "remote-converge-selection-org" })
    await addMembership(org.id, user.id, "approver")
    await updateOrg(org.id, {
      planTier: "pro",
      subscriptionStatus: "active",
    })
    await db.insert(repositories).values({
      orgId: org.id,
      githubId: 12345,
      name: "fixture",
      fullName: "test-org/fixture",
      defaultBranch: "main",
      installationId: 67890,
      isActive: true,
    })

    const principal = await ensureAccountPrincipal({ userId: user.id })
    const token = await generateAccountPrincipalToken({
      principalId: principal.id,
      userId: user.id,
    })

    const app = new Hono()
    app.route("/api/cloud", createCloudConvergeRoute({
      loadConfig: async () => parseYaffleToml(`
version = 1

[cloud.triggers.github]
push = [{ environment = "main", ref_patterns = ["refs/heads/main"] }]

[[workspaces]]
path = "apps/control-plane/infra"
environments = ["main"]
`),
      loadInstallationToken: async () => "installation-token",
      scanDispatcher: async () => ({ scanJobId: "scan-job-1" }),
    }))

    const response = await app.fetch(new Request("http://localhost/api/cloud/converge", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "feature-token": TEST_FEATURE_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        repoFullName: "test-org/fixture",
        environmentName: "main",
        ref: "refs/heads/main",
        headSha: "abc123def456",
        workspacePaths: ["apps/web/infra"],
      }),
    }))

    expect(response.status).toBe(400)
    const body = await response.json() as { error: { code: string } }
    expect(body.error.code).toBe("INVALID_SELECTION")
  })
})
