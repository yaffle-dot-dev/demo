import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { sql } from "drizzle-orm"

import { createGithubInstallation, createOrg } from "../db/queries/organizations.ts"
import { createRunGroup } from "../db/queries/run-groups.ts"
import { previews, iacJobs } from "../db/schema.ts"
import { db } from "./db.ts"

process.env.YAFFLE_FREE_LIMIT_CONCURRENT_PREVIEWS = "1"
process.env.YAFFLE_FREE_LIMIT_MONTHLY_PREVIEWS = "99"
process.env.YAFFLE_FREE_LIMIT_NAMED_ENVIRONMENTS = "1"
process.env.BETTER_AUTH_URL = "https://yaffle.local:6969"

const mockCreateCheckRun = mock(async () => 1)
const mockUpdateCheckRun = mock(async () => {})

mock.module("./github.ts", () => ({
  createCheckRun: mockCreateCheckRun,
  updateCheckRun: mockUpdateCheckRun,
}))

const { completeRunGroup } = await import("./run-group-orchestrator.ts")

function assertTestDatabase(): void {
  const dbUrl = process.env.DATABASE_URL ?? ""
  if (!dbUrl.includes("_test")) {
    throw new Error(
      `FATAL: Test attempted to truncate tables but DATABASE_URL doesn't contain '_test'. ` +
      `Current URL: ${dbUrl.replace(/\/\/[^@]+@/, "//***@")}`,
    )
  }
}

describe("run-group-orchestrator", () => {
  beforeEach(async () => {
    assertTestDatabase()

    mockCreateCheckRun.mockReset()
    mockCreateCheckRun.mockImplementation(async () => 1)
    mockUpdateCheckRun.mockReset()
    mockUpdateCheckRun.mockImplementation(async () => {})

    await db.execute(
      sql`TRUNCATE TABLE
        iac_jobs,
        tf_runs,
        workspace_deployments,
        run_groups,
        repositories,
        github_repo_mappings,
        github_installations,
        organizations
      CASCADE`,
    )
  })

  afterAll(async () => {
    assertTestDatabase()
    await db.execute(
      sql`TRUNCATE TABLE
        iac_jobs,
        tf_runs,
        workspace_deployments,
        run_groups,
        repositories,
        github_repo_mappings,
        github_installations,
        organizations
      CASCADE`,
    )
  })

  test("writes a failed GitHub check when a run group is plan-limited", async () => {
    const org = await createOrg({
      name: "Test Org",
      slug: "test-org",
    })

    await createGithubInstallation({
      orgId: org.id,
      githubOrgId: 99999,
      githubOrgLogin: "test-owner",
      installationId: 12345,
    })

    const runGroup = await createRunGroup({
      orgId: org.id,
      repo: "test-repo",
      environmentKind: "transient",
      environmentName: "pr-42",
      prNumber: 42,
      ref: "refs/heads/feature/test",
      headSha: "abc123def456",
      trigger: "pr_opened",
      status: "pending",
    })

    await completeRunGroup(runGroup.id, {
      graph: {
        workspaces: ["infra"],
        edges: [],
      },
      executionOrder: ["infra"],
    })

    const deployments = await db.select().from(previews)
    expect(deployments).toHaveLength(1)
    expect(deployments[0].status).toBe("plan_limited")

    const jobs = await db.select().from(iacJobs)
    expect(jobs).toHaveLength(0)

    expect(mockCreateCheckRun).toHaveBeenCalledTimes(1)
    expect(mockCreateCheckRun).toHaveBeenCalledWith(12345, {
      owner: "test-owner",
      repo: "test-repo",
      headSha: "abc123def456",
      name: "Yaffle / run",
      status: "completed",
      conclusion: "failure",
      detailsUrl: `https://yaffle.local:6969/app/test-org/test-repo/env/pr-42?runGroupId=${runGroup.id}`,
      title: "Failed due to plan limits",
      summary:
        "Free tier limit: 1 concurrent preview branches. You have 1 active. Upgrade to Pro at https://yaffle.local:6969/test-org/settings/billing for unlimited previews.\n\n" +
        `[View more details at yaffle.local](https://yaffle.local:6969/app/test-org/test-repo/env/pr-42?runGroupId=${runGroup.id})`,
    })
  })

  test("does not mark unrelated named-environment workspaces destroyed for manual subset runs", async () => {
    const org = await createOrg({
      name: "Test Org",
      slug: "test-org-manual-subset",
    })

    await db.insert(previews).values({
      orgId: org.id,
      repo: "test-repo",
      environmentKind: "named",
      environmentName: "main",
      workspacePath: "apps/provider-discovery-agent/infra",
      ref: "refs/heads/main",
      headSha: "oldsha",
      status: "ready",
      stateKey: "production/main/apps/provider-discovery-agent/infra/terraform.tfstate",
      mode: "terraform",
    })

    const runGroup = await createRunGroup({
      orgId: org.id,
      repo: "test-repo",
      environmentKind: "named",
      environmentName: "main",
      prNumber: null,
      ref: "refs/heads/main",
      headSha: "abc123def456",
      selectedWorkspacePaths: ["apps/control-plane/infra"],
      trigger: "manual",
      status: "pending",
    })

    await completeRunGroup(runGroup.id, {
      graph: {
        workspaces: ["apps/control-plane/infra"],
        edges: [],
      },
      executionOrder: ["apps/control-plane/infra"],
    })

    const deployments = await db.select().from(previews)
    const providerDiscovery = deployments.find((deployment) =>
      deployment.workspacePath === "apps/provider-discovery-agent/infra"
    )

    expect(providerDiscovery?.status).toBe("ready")
  })

  test("marks removed named-environment workspaces destroyed for push runs", async () => {
    const org = await createOrg({
      name: "Test Org",
      slug: "test-org-push-destroy",
    })

    await db.insert(previews).values({
      orgId: org.id,
      repo: "test-repo",
      environmentKind: "named",
      environmentName: "main",
      workspacePath: "apps/provider-discovery-agent/infra",
      ref: "refs/heads/main",
      headSha: "oldsha",
      status: "ready",
      stateKey: "production/main/apps/provider-discovery-agent/infra/terraform.tfstate",
      mode: "terraform",
    })

    const runGroup = await createRunGroup({
      orgId: org.id,
      repo: "test-repo",
      environmentKind: "named",
      environmentName: "main",
      prNumber: null,
      ref: "refs/heads/main",
      headSha: "abc123def456",
      trigger: "push",
      status: "pending",
    })

    await completeRunGroup(runGroup.id, {
      graph: {
        workspaces: ["apps/control-plane/infra"],
        edges: [],
      },
      executionOrder: ["apps/control-plane/infra"],
    })

    const deployments = await db.select().from(previews)
    const providerDiscovery = deployments.find((deployment) =>
      deployment.workspacePath === "apps/provider-discovery-agent/infra"
    )

    expect(providerDiscovery?.status).toBe("destroyed")
  })
})
