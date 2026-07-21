import { afterAll, beforeEach, describe, expect, mock, test } from "@yaffle/test"
import { eq, sql } from "drizzle-orm"

import { createOrg, updateOrg } from "../db/queries/organizations.ts"
import { createPrincipal, ensurePrincipalRepoBinding } from "../db/queries/principals.ts"
import { createRunGroup } from "../db/queries/run-groups.ts"
import { previews, iacJobs, runGroups, stateVersions, workspaces } from "../db/schema.ts"
import { db } from "./db.ts"
import type { ExecutionSnapshotV1 } from "./execution-snapshot.ts"

process.env.YAFFLE_FREE_LIMIT_CONCURRENT_PREVIEWS = "1"
process.env.YAFFLE_FREE_LIMIT_MONTHLY_PREVIEWS = "99"
process.env.YAFFLE_FREE_LIMIT_NAMED_ENVIRONMENTS = "1"
process.env.BETTER_AUTH_URL = "https://yaffle.local:6969"

const mockCompleteRunGroupCheck = mock(async () => {})

const { completeRunGroup } = await import("./run-group-orchestrator.ts")

function transientSnapshot(values: {
  environmentName: string
  workspacePath: string
  prNumber: number | null
  installationId?: number
}): ExecutionSnapshotV1 {
  return {
    version: 1,
    source: {
      installationId: values.installationId ?? 0,
      repositoryId: 123,
      ownerId: 456,
      owner: "test-owner",
      repository: "test-repo",
      defaultBranch: "main",
      ref: "refs/heads/feature/test",
      commitSha: "abc123def456",
      baseSha: null,
      actor: { githubId: 789, login: "test-author" },
    },
    configuration: {
      path: "yaffle.toml",
      revision: "abc123def456",
      digest: "test-digest",
    },
    environment: {
      kind: "transient",
      name: values.environmentName,
      sourcePullRequestNumber: values.prNumber,
    },
    workspaces: [
      {
        path: values.workspacePath,
        variables: { release: "snapshot" },
        approval: {
          required: true,
          approvers: ["github:user:reviewer"],
        },
        lifecycle: { activation: [], verification: [] },
        outputs: {},
        automaticPreviewIsolation: false,
      },
    ],
  }
}

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

    mockCompleteRunGroupCheck.mockReset()
    mockCompleteRunGroupCheck.mockImplementation(async () => {})

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

    const runGroup = await createRunGroup({
      orgId: org.id,
      repo: "test-repo",
      environmentKind: "transient",
      environmentName: "pr-42",
      prNumber: 42,
      ref: "refs/heads/feature/test",
      headSha: "abc123def456",
      selectedWorkspacePaths: ["infra"],
      executionSnapshot: transientSnapshot({
        environmentName: "pr-42",
        workspacePath: "infra",
        prNumber: 42,
        installationId: 12345,
      }),
      trigger: "pr_opened",
      status: "pending",
    })

    await completeRunGroup(
      runGroup.id,
      {
        graph: {
          workspaces: ["infra"],
          edges: [],
        },
        executionOrder: ["infra"],
      },
      { completeRunGroupCheck: mockCompleteRunGroupCheck },
    )

    const deployments = await db.select().from(previews)
    expect(deployments).toHaveLength(1)
    expect(deployments[0].status).toBe("plan_limited")
    expect(deployments[0]).toMatchObject({
      installationId: 12345,
      authorGithubId: 789,
      authorLogin: "test-author",
      requireApproval: true,
      approvers: ["github:user:reviewer"],
      headSha: "abc123def456",
    })

    const jobs = await db.select().from(iacJobs)
    expect(jobs).toHaveLength(0)

    expect(mockCompleteRunGroupCheck).toHaveBeenCalledTimes(1)
    expect(mockCompleteRunGroupCheck).toHaveBeenCalledWith({
      runGroupId: runGroup.id,
      conclusion: "failure",
      title: "Failed due to plan limits",
      summary:
        "Free tier limit: 1 concurrent preview branches. You have 1 active. Upgrade to Pro at https://yaffle.local:6969/test-org/settings/billing for unlimited previews.",
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
    const providerDiscovery = deployments.find(
      (deployment) => deployment.workspacePath === "apps/provider-discovery-agent/infra",
    )

    expect(providerDiscovery?.status).toBe("ready")
  })

  test("isolates source-neutral transient state by environment identity", async () => {
    const org = await createOrg({
      name: "Transient Test Org",
      slug: "transient-test-org",
    })
    await updateOrg(org.id, {
      planTier: "pro",
      subscriptionStatus: "active",
    })
    const principal = await createPrincipal({ type: "anonymous_session" })
    const repoBinding = await ensurePrincipalRepoBinding({
      principalId: principal.id,
      canonicalRepoNamespace: "test-owner--test-repo",
      localRepoFingerprint: `orchestrator-${crypto.randomUUID()}`,
    })

    const runGroup = await createRunGroup({
      orgId: org.id,
      repoBindingId: repoBinding.id,
      repo: "test-repo",
      environmentKind: "transient",
      environmentName: "review-42",
      prNumber: null,
      ref: "refs/heads/feature/test",
      headSha: "abc123def456",
      selectedWorkspacePaths: ["infra"],
      executionSnapshot: transientSnapshot({
        environmentName: "review-42",
        workspacePath: "infra",
        prNumber: null,
      }),
      trigger: "manual",
      status: "pending",
    })

    await db
      .update(runGroups)
      .set({ workspaceS3Key: "test-owner/test-repo/abc123def456/workspace.tar.gz" })
      .where(eq(runGroups.id, runGroup.id))
    await completeRunGroup(runGroup.id, {
      graph: {
        workspaces: ["infra"],
        edges: [],
      },
      executionOrder: ["infra"],
    })

    const deployments = await db.select().from(previews)
    expect(deployments).toHaveLength(1)
    expect(deployments[0]).toMatchObject({
      environmentKind: "transient",
      environmentName: "review-42",
      prNumber: null,
      stateKey: "transient-review-42/infra/terraform.tfstate",
    })
  })

  test("queues merge-impact plans for every workspace without waiting on the preview DAG", async () => {
    const org = await createOrg({ name: "Parallel Plan Org", slug: "parallel-plan-org" })
    await updateOrg(org.id, { planTier: "pro", subscriptionStatus: "active" })
    const principal = await createPrincipal({ type: "anonymous_session" })
    const repoBinding = await ensurePrincipalRepoBinding({
      principalId: principal.id,
      canonicalRepoNamespace: "test-owner--test-repo",
      localRepoFingerprint: `parallel-${crypto.randomUUID()}`,
    })
    const workspacePaths = ["infra", "infra/monitoring"]
    for (const [index, workspacePath] of workspacePaths.entries()) {
      const [workspace] = await db
        .insert(workspaces)
        .values({
          orgId: org.id,
          name: `test-repo-main-${index}`,
          repo: "test-repo",
          workspacePath,
          environmentKind: "named",
          environmentName: "main",
          ref: "refs/heads/main",
        })
        .returning()
      const [stateVersion] = await db
        .insert(stateVersions)
        .values({
          workspaceId: workspace.id,
          serial: 1,
          md5: `state-${index}`,
          size: 1,
          s3Key: `states/${index}.tfstate`,
          status: "finalized",
        })
        .returning()
      await db
        .update(workspaces)
        .set({ currentStateVersionId: stateVersion.id })
        .where(eq(workspaces.id, workspace.id))
    }

    const snapshot = transientSnapshot({
      environmentName: "pr-42",
      workspacePath: "infra",
      prNumber: 42,
    })
    snapshot.source.baseSha = "base-sha"
    snapshot.workspaces.push({
      ...snapshot.workspaces[0],
      path: "infra/monitoring",
    })
    snapshot.mergeImpact = {
      environmentName: "main",
      ref: "refs/heads/main",
      configurationRevision: "base-sha",
      configurationDigest: "base-digest",
      workspaces: workspacePaths.map((path) => ({ path, variables: {} })),
    }
    const runGroup = await createRunGroup({
      orgId: org.id,
      repoBindingId: repoBinding.id,
      repo: "test-repo",
      environmentKind: "transient",
      environmentName: "pr-42",
      prNumber: 42,
      ref: snapshot.source.ref,
      headSha: snapshot.source.commitSha,
      selectedWorkspacePaths: workspacePaths,
      executionSnapshot: snapshot,
      trigger: "pr_opened",
      status: "pending",
    })
    await db
      .update(runGroups)
      .set({ workspaceS3Key: "parallel/workspace.tar.gz" })
      .where(eq(runGroups.id, runGroup.id))

    await completeRunGroup(runGroup.id, {
      graph: {
        workspaces: workspacePaths,
        edges: [["infra", "infra/monitoring"]],
      },
      executionOrder: workspacePaths,
    })

    const jobs = await db.select().from(iacJobs)
    expect(jobs.filter((job) => job.planPurpose === "environment")).toHaveLength(1)
    expect(jobs.filter((job) => job.planPurpose === "merge_impact")).toHaveLength(2)
  })

  test("rejects scanner output that changes the snapshotted workspace selection", async () => {
    const org = await createOrg({
      name: "Immutable Selection Org",
      slug: "immutable-selection-org",
    })
    await updateOrg(org.id, {
      planTier: "pro",
      subscriptionStatus: "active",
    })

    const runGroup = await createRunGroup({
      orgId: org.id,
      repo: "test-repo",
      environmentKind: "transient",
      environmentName: "review-42",
      prNumber: null,
      ref: "refs/heads/feature/test",
      headSha: "abc123def456",
      selectedWorkspacePaths: ["infra"],
      executionSnapshot: transientSnapshot({
        environmentName: "review-42",
        workspacePath: "infra",
        prNumber: null,
      }),
      trigger: "manual",
      status: "pending",
    })

    await expect(
      completeRunGroup(runGroup.id, {
        graph: {
          workspaces: ["other"],
          edges: [],
        },
        executionOrder: ["other"],
      }),
    ).rejects.toThrow("workspace selection")

    expect(await db.select().from(previews)).toHaveLength(0)
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
    const providerDiscovery = deployments.find(
      (deployment) => deployment.workspacePath === "apps/provider-discovery-agent/infra",
    )

    expect(providerDiscovery?.status).toBe("destroyed")
  })
})
