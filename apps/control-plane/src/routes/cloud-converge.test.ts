import { afterEach, beforeEach, describe, expect, test } from "@yaffle/test"
import { Hono } from "hono"

import { db } from "../lib/db.ts"
import { ensureAccountPrincipal, ensurePrincipalRepoBinding } from "../db/queries/principals.ts"
import { updateOrg } from "../db/queries/organizations.ts"
import { parseYaffleToml } from "../lib/config-toml.ts"
import { generateAccountPrincipalToken } from "../lib/principal-tokens.ts"
import {
  lifecycleItems,
  lifecycleRuns,
  repositories,
  runGroups,
  tfRuns,
  workspaceDeployments,
} from "../db/schema.ts"
import {
  addMembership,
  cleanupTestData,
  createTestOrg,
  createTestUser,
} from "../test-utils/auth.ts"

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
      scan?: {
        runGroupId: string
        workspacePaths: string[]
        automaticIsolationWorkspacePaths: string[]
        installationToken: string
      }
    } = {}
    const app = new Hono()
    app.route(
      "/api/cloud",
      createCloudConvergeRoute({
        loadConfig: async () =>
          parseYaffleToml(`
version = 1

[[environments]]
name = "main"

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
            automaticIsolationWorkspacePaths: input.automaticIsolationWorkspacePaths,
            installationToken: input.installationToken,
          }
          return { scanJobId: "scan-job-1" }
        },
      }),
    )

    const response = await app.fetch(
      new Request("http://localhost/api/cloud/converge", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "feature-token": TEST_FEATURE_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          repoFullName: "test-org/fixture",
          canonicalRepoNamespace: "test-org--fixture",
          localRepoFingerprint: "repo-fingerprint-1",
          environmentName: "main",
          ref: "refs/heads/main",
          headSha: "abc123def456",
          workspacePaths: ["apps/control-plane/infra"],
        }),
      }),
    )

    expect(response.status).toBe(202)
    const body = (await response.json()) as {
      data: { runGroupId: string; scanJobId: string; workspacePaths: string[]; status: string }
    }
    expect(body.data.scanJobId).toBe("scan-job-1")
    expect(body.data.workspacePaths).toEqual(["apps/control-plane/infra"])
    expect(body.data.status).toBe("queued")
    expect(seen.installationId).toBe(67890)
    expect(seen.scan?.workspacePaths).toEqual(["apps/control-plane/infra"])
    expect(seen.scan?.automaticIsolationWorkspacePaths).toEqual([])
    expect(seen.scan?.installationToken).toBe("installation-token")

    const runGroup = await db.query.runGroups.findFirst({
      where: (runGroups, { eq }) => eq(runGroups.id, body.data.runGroupId),
    })
    expect(runGroup?.trigger).toBe("manual")
    expect(runGroup?.environmentName).toBe("main")
    expect(runGroup?.prNumber).toBeNull()
    expect(runGroup?.ref).toBe("refs/heads/main")
    expect(runGroup?.repoBindingId).toBeTruthy()
    expect(seen.scan?.runGroupId).toBe(body.data.runGroupId)
  })

  test("reports remote converge capability for a paid-cloud approver", async () => {
    const user = await createTestUser({ id: "remote-capability-user" })
    const org = await createTestOrg({ slug: "remote-capability-org" })
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
    app.route("/api/cloud", createCloudConvergeRoute())

    const response = await app.fetch(
      new Request("http://localhost/api/cloud/capabilities?repoFullName=test-org/fixture", {
        headers: {
          authorization: `Bearer ${token}`,
          "feature-token": TEST_FEATURE_TOKEN,
        },
      }),
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: {
        executionMode: string
        principalTier: string
        remoteConverge: { available: boolean; reasonCode: string | null }
      }
    }
    expect(body.data.executionMode).toBe("remote")
    expect(body.data.principalTier).toBe("paid_cloud")
    expect(body.data.remoteConverge.available).toBe(true)
    expect(body.data.remoteConverge.reasonCode).toBeNull()
  })

  test("reports local-only capability for an account without paid-cloud entitlement", async () => {
    const user = await createTestUser({ id: "remote-capability-free-user" })
    const org = await createTestOrg({ slug: "remote-capability-free-org" })
    await addMembership(org.id, user.id, "approver")
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
    app.route("/api/cloud", createCloudConvergeRoute())

    const response = await app.fetch(
      new Request("http://localhost/api/cloud/capabilities?repoFullName=test-org/fixture", {
        headers: {
          authorization: `Bearer ${token}`,
          "feature-token": TEST_FEATURE_TOKEN,
        },
      }),
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: {
        executionMode: string
        principalTier: string
        remoteConverge: { available: boolean; reasonCode: string | null }
      }
    }
    expect(body.data.executionMode).toBe("local")
    expect(body.data.principalTier).toBe("free_local")
    expect(body.data.remoteConverge.available).toBe(false)
    expect(body.data.remoteConverge.reasonCode).toBe("PAID_CLOUD_REQUIRED")
  })

  test("defaults to all eligible workspaces when no explicit selection is provided", async () => {
    const user = await createTestUser({ id: "remote-converge-all-user" })
    const org = await createTestOrg({ slug: "remote-converge-all-org" })
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

    const seen: { workspacePaths?: string[] } = {}
    const app = new Hono()
    app.route(
      "/api/cloud",
      createCloudConvergeRoute({
        loadConfig: async () =>
          parseYaffleToml(`
version = 1

[[environments]]
name = "main"

[cloud.triggers.github]
push = [{ environment = "main", ref_patterns = ["refs/heads/main"] }]

[[workspaces]]
path = "apps/control-plane/infra"
environments = ["main"]

[[workspaces]]
path = "apps/web/infra"
environments = ["main"]
`),
        loadInstallationToken: async () => "installation-token",
        scanDispatcher: async (input) => {
          seen.workspacePaths = input.workspacePaths
          return { scanJobId: "scan-job-1" }
        },
      }),
    )

    const response = await app.fetch(
      new Request("http://localhost/api/cloud/converge", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "feature-token": TEST_FEATURE_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          repoFullName: "test-org/fixture",
          canonicalRepoNamespace: "test-org--fixture",
          localRepoFingerprint: "repo-fingerprint-1",
          environmentName: "main",
          ref: "refs/heads/main",
          headSha: "abc123def456",
        }),
      }),
    )

    expect(response.status).toBe(202)
    const body = (await response.json()) as {
      data: { workspacePaths: string[] }
    }
    expect(body.data.workspacePaths).toEqual(["apps/control-plane/infra", "apps/web/infra"])
    expect(seen.workspacePaths).toEqual(["apps/control-plane/infra", "apps/web/infra"])
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
    app.route(
      "/api/cloud",
      createCloudConvergeRoute({
        loadConfig: async () => parseYaffleToml(`version = 1`),
        loadInstallationToken: async () => "installation-token",
        scanDispatcher: async () => ({ scanJobId: "scan-job-1" }),
      }),
    )

    const response = await app.fetch(
      new Request("http://localhost/api/cloud/converge", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "feature-token": TEST_FEATURE_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          repoFullName: "test-org/fixture",
          canonicalRepoNamespace: "test-org--fixture",
          localRepoFingerprint: "repo-fingerprint-1",
          environmentName: "main",
          ref: "refs/heads/main",
          headSha: "abc123def456",
          workspacePaths: ["apps/control-plane/infra"],
        }),
      }),
    )

    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: { code: string } }
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
    app.route(
      "/api/cloud",
      createCloudConvergeRoute({
        loadConfig: async () =>
          parseYaffleToml(`
version = 1

[[environments]]
name = "main"

[cloud.triggers.github]
push = [{ environment = "main", ref_patterns = ["refs/heads/main"] }]

[[workspaces]]
path = "apps/control-plane/infra"
environments = ["main"]
`),
        loadInstallationToken: async () => "installation-token",
        scanDispatcher: async () => ({ scanJobId: "scan-job-1" }),
      }),
    )

    const response = await app.fetch(
      new Request("http://localhost/api/cloud/converge", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "feature-token": TEST_FEATURE_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          repoFullName: "test-org/fixture",
          canonicalRepoNamespace: "test-org--fixture",
          localRepoFingerprint: "repo-fingerprint-1",
          environmentName: "main",
          ref: "refs/heads/main",
          headSha: "abc123def456",
          workspacePaths: ["apps/web/infra"],
        }),
      }),
    )

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe("INVALID_SELECTION")
  })

  test("returns hosted converge run-group status for authorized viewers", async () => {
    const user = await createTestUser({ id: "remote-converge-status-user" })
    const org = await createTestOrg({ slug: "remote-converge-status-org" })
    await addMembership(org.id, user.id, "viewer")
    const principal = await ensureAccountPrincipal({ userId: user.id })
    const binding = await ensurePrincipalRepoBinding({
      principalId: principal.id,
      canonicalRepoNamespace: "remote-converge-status-org--fixture",
      localRepoFingerprint: "remote-converge-status-fixture",
    })

    const [runGroup] = await db
      .insert(runGroups)
      .values({
        orgId: org.id,
        repoBindingId: binding.id,
        repo: "fixture",
        environmentKind: "named",
        environmentName: "main",
        ref: "refs/heads/main",
        headSha: "abc123def456",
        executionSnapshot: {
          version: 1,
          source: {
            installationId: 67890,
            repositoryId: 123,
            ownerId: 456,
            owner: "remote-converge-status-org",
            repository: "fixture",
            defaultBranch: "main",
            ref: "refs/heads/main",
            commitSha: "abc123def456",
            baseSha: null,
            actor: { githubId: null, login: "manual" },
          },
          configuration: {
            path: "yaffle.toml",
            revision: "abc123def456",
            digest: "snapshot-digest",
          },
          environment: {
            kind: "named",
            name: "main",
            sourcePullRequestNumber: null,
          },
          workspaces: [
            {
              path: "apps/control-plane/infra",
              variables: { internalMarker: "must-not-leak-variable" },
              approval: { required: false, approvers: [] },
              lifecycle: {
                activation: [
                  {
                    key: "private-hook",
                    environments: ["*"],
                    kind: "generic",
                    failure: "failed",
                    scopes: [],
                    request: {
                      url: "https://must-not-leak-lifecycle.example.test",
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
        trigger: "manual",
        status: "running",
        startedAt: new Date(),
      })
      .returning()

    const [deployment] = await db
      .insert(workspaceDeployments)
      .values({
        orgId: org.id,
        repo: "fixture",
        environmentKind: "named",
        environmentName: "main",
        workspacePath: "apps/control-plane/infra",
        ref: "refs/heads/main",
        headSha: "abc123def456",
        installationId: 67890,
        runGroupId: runGroup.id,
        stateKey: "production/main/terraform.tfstate",
        mode: "preview",
        requireApproval: false,
        approvers: [],
        status: "planning",
        statusChangedAt: new Date(),
        completedUpstreams: [],
      })
      .returning()

    await db.insert(tfRuns).values({
      deploymentId: deployment.id,
      runGroupId: runGroup.id,
      runType: "plan",
      status: "running",
      planSummary: "+1, ~0, -0",
      startedAt: new Date(),
    })

    const token = await generateAccountPrincipalToken({
      principalId: principal.id,
      userId: user.id,
    })

    const app = new Hono()
    app.route("/api/cloud", createCloudConvergeRoute())

    const response = await app.fetch(
      new Request(`http://localhost/api/cloud/converge/${runGroup.id}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "feature-token": TEST_FEATURE_TOKEN,
        },
      }),
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: {
        runGroup: {
          id: string
          status: string
          executionContext: {
            version: number
            commitSha: string
            configurationRevision: string
            configurationDigest: string
          } | null
        }
        deployments: Array<{
          workspacePath: string
          status: string
          latestRun: null | { runType: string; status: string; planSummary: string | null }
        }>
      }
    }
    expect(body.data.runGroup.id).toBe(runGroup.id)
    expect(body.data.runGroup.status).toBe("running")
    expect(body.data.runGroup.executionContext).toEqual({
      version: 1,
      commitSha: "abc123def456",
      configurationRevision: "abc123def456",
      configurationDigest: "snapshot-digest",
    })
    expect(JSON.stringify(body)).not.toContain("must-not-leak-variable")
    expect(JSON.stringify(body)).not.toContain("must-not-leak-lifecycle")
    expect(body.data.deployments).toHaveLength(1)
    expect(body.data.deployments[0]?.workspacePath).toBe("apps/control-plane/infra")
    expect(body.data.deployments[0]?.latestRun?.runType).toBe("plan")
    expect(body.data.deployments[0]?.latestRun?.status).toBe("running")
  })

  test("keeps hosted converge status running until acceptable lifecycle work settles", async () => {
    const user = await createTestUser({ id: "remote-converge-lifecycle-user" })
    const org = await createTestOrg({ slug: "remote-converge-lifecycle-org" })
    await addMembership(org.id, user.id, "viewer")

    const [runGroup] = await db
      .insert(runGroups)
      .values({
        orgId: org.id,
        repo: "fixture",
        environmentKind: "named",
        environmentName: "main",
        ref: "refs/heads/main",
        headSha: "abc123def456",
        trigger: "manual",
        status: "success",
        startedAt: new Date(),
      })
      .returning()

    const [deployment] = await db
      .insert(workspaceDeployments)
      .values({
        orgId: org.id,
        repo: "fixture",
        environmentKind: "named",
        environmentName: "main",
        workspacePath: "apps/control-plane/infra",
        ref: "refs/heads/main",
        headSha: "abc123def456",
        installationId: 67890,
        runGroupId: runGroup.id,
        stateKey: "production/main/terraform.tfstate",
        mode: "preview",
        requireApproval: false,
        approvers: [],
        status: "ready",
        statusChangedAt: new Date(),
        completedUpstreams: [],
      })
      .returning()

    const principal = await ensureAccountPrincipal({ userId: user.id })
    const binding = await ensurePrincipalRepoBinding({
      principalId: principal.id,
      canonicalRepoNamespace: "test-org--fixture",
      localRepoFingerprint: "repo-fingerprint-1",
    })

    const [lifecycleRun] = await db
      .insert(lifecycleRuns)
      .values({
        principalId: principal.id,
        repoBindingId: binding.id,
        runGroupId: runGroup.id,
        environmentName: "main",
        executionMode: "cloud",
        status: "running",
      })
      .returning()

    await db.insert(lifecycleItems).values([
      {
        runId: lifecycleRun.id,
        workspacePath: deployment.workspacePath,
        key: "activate",
        phase: "activation",
        kind: "webhook",
        state: "succeeded",
        failurePolicy: "failed",
        scopes: ["usable"],
        destinationUrl: "https://example.com/activate",
        destinationClass: "public",
        dispatchMode: "cloud",
      },
      {
        runId: lifecycleRun.id,
        workspacePath: deployment.workspacePath,
        key: "verify",
        phase: "verification",
        kind: "webhook",
        state: "running",
        failurePolicy: "failed",
        scopes: ["acceptable"],
        destinationUrl: "https://example.com/verify",
        destinationClass: "public",
        dispatchMode: "cloud",
      },
    ])

    const token = await generateAccountPrincipalToken({
      principalId: principal.id,
      userId: user.id,
    })

    const app = new Hono()
    app.route("/api/cloud", createCloudConvergeRoute())

    const response = await app.fetch(
      new Request(`http://localhost/api/cloud/converge/${runGroup.id}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "feature-token": TEST_FEATURE_TOKEN,
        },
      }),
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: {
        runGroup: { status: string }
      }
    }
    expect(body.data.runGroup.status).toBe("running")
  })
})
