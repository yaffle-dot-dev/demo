import { afterAll, beforeEach, describe, expect, mock, test } from "@yaffle/test"
import { sql } from "drizzle-orm"

import type {
  PullRequestContext,
  PushContext,
  TerraformResult,
  WebhookContext,
} from "@yaffle/shared"

import type { YaffleTomlConfig } from "./config-toml.ts"
import { getRunGroupCheckSummary } from "./run-group-check-copy.ts"
import { createGithubInstallation, createOrg } from "../db/queries/organizations.ts"
import { setRepoMapping } from "../db/queries/repo-mappings.ts"
import { completeJob } from "../db/queries/iac-jobs.ts"
import { claimScanJob, completeScanJob, createScanJob } from "../db/queries/scan-jobs.ts"
import { runGroups, previews, iacJobs } from "../db/schema.ts"
import { db } from "./db.ts"
import { KeyedMutex } from "./mutex.ts"
import type { Runner, RunOpts } from "./runner.ts"

const mockFetchFileContent = mock(async () => undefined as string | undefined)
const mockGetInstallationToken = mock(async () => "test-installation-token")
const mockCreateCheckRun = mock(async () => 123)
const mockUpdateCheckRun = mock(async () => {})
const mockCheckTeamMembership = mock(async () => false)
const mockUpsertPrComment = mock(async () => 1)

mock.module("./github.ts", () => ({
  fetchFileContent: mockFetchFileContent,
  getInstallationToken: mockGetInstallationToken,
  createCheckRun: mockCreateCheckRun,
  updateCheckRun: mockUpdateCheckRun,
  checkTeamMembership: mockCheckTeamMembership,
  upsertPrComment: mockUpsertPrComment,
}))

const { createHandler } = await import("./webhook-handler.ts")
const { completeRunGroup } = await import("./run-group-orchestrator.ts")
const { updateDeploymentStatus } = await import("../db/queries/workspace-deployments.ts")

class FakeRunner implements Runner {
  async run(_opts: RunOpts): Promise<TerraformResult> {
    throw new Error("runner should not be called in check lifecycle tests")
  }
}

const DEFAULT_CONFIG: YaffleTomlConfig = {
  version: 1,
  environments: [{ name: "main" }],
  workspaces: [
    {
      path: "infra",
      environments: "*",
    },
  ],
  cloud: {
    triggers: {
      github: {
        push: [{ ref_patterns: ["refs/heads/main"], exclude_ref_patterns: [], environment: "main" }],
        pull_request: [{ branch_patterns: ["*"], exclude_branch_patterns: [] }],
      },
    },
    approvals: [],
  },
}

function fakeConfigLoader(config: YaffleTomlConfig) {
  return async (_ctx: WebhookContext, _token?: string): Promise<YaffleTomlConfig> => config
}

async function fakeScanDispatcher(
  ctx: WebhookContext,
  orgId: string,
  orgSlug: string,
  runGroupId: string,
  workspacePaths: string[],
  workspaceVariables: Record<string, Record<string, string | number | boolean>>,
  installationToken?: string,
): Promise<void> {
  const scanJob = await createScanJob({
    runGroupId,
    orgId,
    repoUrl: `https://github.com/${ctx.owner}/${ctx.repo}.git`,
    ref: ctx.kind === "pull_request" ? `refs/heads/${ctx.branch}` : ctx.ref,
    headSha: ctx.headSha,
    installationToken,
    orgSlug,
    workspacePaths,
    workspaceVariables,
  })

  const claimed = await claimScanJob(scanJob.id, "test-scanner")
  if (!claimed.claimed) {
    throw new Error(`Failed to claim fake scan job ${scanJob.id}`)
  }

  const result = {
    graph: {
      workspaces: workspacePaths,
      edges: [] as [string, string][],
    },
    executionOrder: workspacePaths,
  }

  const completed = await completeScanJob(scanJob.id, result)
  if (!completed) {
    throw new Error(`Failed to complete fake scan job ${scanJob.id}`)
  }

  await completeRunGroup(runGroupId, result)
}

function makePrContext(overrides?: Partial<PullRequestContext>): PullRequestContext {
  return {
    kind: "pull_request",
    installationId: 0,
    repoGithubId: 123456,
    ownerGithubId: 99999,
    owner: "test-org",
    repo: "test-repo",
    prNumber: 42,
    action: "opened",
    headSha: "abc123def456",
    branch: "feature/test",
    authorGithubId: 12345,
    authorLogin: "octocat",
    merged: false,
    defaultBranch: "main",
    ...overrides,
  }
}

function makePushContext(overrides?: Partial<PushContext>): PushContext {
  const ref = overrides?.ref ?? "refs/heads/main"
  const refType = ref.startsWith("refs/tags/") ? "tag" : "branch"
  const refName = ref.replace(/^refs\/(heads|tags)\//, "")
  return {
    kind: "push",
    installationId: 0,
    repoGithubId: 123456,
    ownerGithubId: 99999,
    owner: "test-org",
    repo: "test-repo",
    headSha: "abc123def456",
    ref,
    refType,
    refName,
    pusherGithubId: 12345,
    pusherLogin: "octocat",
    defaultBranch: "main",
    ...overrides,
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

describe("run-group-checks", () => {
  let handler: ReturnType<typeof createHandler>

  beforeEach(async () => {
    assertTestDatabase()

    mockFetchFileContent.mockReset()
    mockFetchFileContent.mockImplementation(async () => undefined)
    mockGetInstallationToken.mockReset()
    mockGetInstallationToken.mockImplementation(async () => "test-installation-token")
    mockCreateCheckRun.mockReset()
    mockCreateCheckRun.mockImplementation(async () => 123)
    mockUpdateCheckRun.mockReset()
    mockUpdateCheckRun.mockImplementation(async () => {})
    mockCheckTeamMembership.mockReset()
    mockCheckTeamMembership.mockImplementation(async () => false)
    mockUpsertPrComment.mockReset()
    mockUpsertPrComment.mockImplementation(async () => 1)

    await db.execute(
      sql`TRUNCATE TABLE
        iac_jobs,
        tf_runs,
        workspace_deployments,
        run_groups,
        scan_jobs,
        repositories,
        github_repo_mappings,
        github_installations,
        organizations
      CASCADE`,
    )

    const org = await createOrg({
      name: "Test Org",
      slug: "test-org",
    })

    await createGithubInstallation({
      orgId: org.id,
      githubOrgId: 99999,
      githubOrgLogin: "test-org",
      installationId: 0,
    })

    await setRepoMapping({
      orgId: org.id,
      installationId: 0,
      githubRepoId: 123456,
    })

    handler = createHandler(new FakeRunner(), {
      mutex: new KeyedMutex(),
      configLoader: fakeConfigLoader(DEFAULT_CONFIG),
      scanDispatcher: fakeScanDispatcher,
    })
  })

  afterAll(async () => {
    assertTestDatabase()
    await db.execute(
      sql`TRUNCATE TABLE
        iac_jobs,
        tf_runs,
        workspace_deployments,
        run_groups,
        scan_jobs,
        repositories,
        github_repo_mappings,
        github_installations,
        organizations
      CASCADE`,
    )
  })

  test("creates a pending check for pull request runs", async () => {
    await handler.handleWebhookEvent(makePrContext())

    const groups = await db.select().from(runGroups)
    expect(groups).toHaveLength(1)

    expect(mockCreateCheckRun).toHaveBeenCalledTimes(1)
    expect(mockCreateCheckRun).toHaveBeenCalledWith(0, {
      owner: "test-org",
      repo: "test-repo",
      headSha: "abc123def456",
      name: "Yaffle / run",
      status: "in_progress",
      detailsUrl:
        "https://yaffle.local:6969/app/test-org/test-repo/env/pr-42?runGroupId=" + groups[0].id,
      title: "Pending",
      summary:
        `${getRunGroupCheckSummary("pending")}\n\n` +
        `[View more details at yaffle.local](https://yaffle.local:6969/app/test-org/test-repo/env/pr-42?runGroupId=${groups[0].id})`,
    })

    expect(groups[0].checkRunId).toBe(123)
    expect(groups[0].checkCompletedAt).toBeNull()
  })

  test("creates a pending check for push runs", async () => {
    await handler.handleWebhookEvent(makePushContext())

    const groups = await db.select().from(runGroups)
    expect(groups).toHaveLength(1)

    expect(mockCreateCheckRun).toHaveBeenCalledTimes(1)
    expect(mockCreateCheckRun).toHaveBeenCalledWith(0, {
      owner: "test-org",
      repo: "test-repo",
      headSha: "abc123def456",
      name: "Yaffle / run",
      status: "in_progress",
      detailsUrl:
        "https://yaffle.local:6969/app/test-org/test-repo/env/main?runGroupId=" + groups[0].id,
      title: "Pending",
      summary:
        `${getRunGroupCheckSummary("pending")}\n\n` +
        `[View more details at yaffle.local](https://yaffle.local:6969/app/test-org/test-repo/env/main?runGroupId=${groups[0].id})`,
    })
  })

  test("does not complete the check when a deployment is only awaiting apply", async () => {
    await handler.handleWebhookEvent(makePrContext())

    mockUpdateCheckRun.mockReset()

    const deployments = await db.select().from(previews)
    expect(deployments).toHaveLength(1)

    await updateDeploymentStatus(deployments[0].id, "awaiting_apply")

    expect(mockUpdateCheckRun).not.toHaveBeenCalled()

    const groups = await db.select().from(runGroups)
    expect(groups[0].checkCompletedAt).toBeNull()
  })

  test("does not complete the check while a job in the run group is still active", async () => {
    await handler.handleWebhookEvent(makePrContext())

    mockUpdateCheckRun.mockReset()

    const deployments = await db.select().from(previews)
    const jobs = await db.select().from(iacJobs)
    expect(deployments).toHaveLength(1)
    expect(jobs).toHaveLength(1)

    await updateDeploymentStatus(deployments[0].id, "ready")

    expect(mockUpdateCheckRun).not.toHaveBeenCalled()

    const groups = await db.select().from(runGroups)
    expect(groups[0].checkCompletedAt).toBeNull()
  })

  test("completes the check successfully when all deployments become ready", async () => {
    await handler.handleWebhookEvent(makePrContext())

    mockUpdateCheckRun.mockReset()

    const groups = await db.select().from(runGroups)
    expect(groups).toHaveLength(1)

    const deployments = await db.select().from(previews)
    const jobs = await db.select().from(iacJobs)
    expect(deployments).toHaveLength(1)
    expect(jobs).toHaveLength(1)

    await completeJob(jobs[0].id, {})

    await updateDeploymentStatus(deployments[0].id, "ready")

    expect(mockUpdateCheckRun).toHaveBeenCalledTimes(1)
    expect(mockUpdateCheckRun).toHaveBeenCalledWith(0, "test-org", "test-repo", 123, {
      status: "completed",
      conclusion: "success",
      detailsUrl:
        "https://yaffle.local:6969/app/test-org/test-repo/env/pr-42?runGroupId=" + groups[0].id,
      title: "Succeeded",
      summary:
        `${getRunGroupCheckSummary("success")}\n\n` +
        `[View more details at yaffle.local](https://yaffle.local:6969/app/test-org/test-repo/env/pr-42?runGroupId=${groups[0].id})`,
    })

    const updatedGroups = await db.select().from(runGroups)
    expect(updatedGroups[0].checkCompletedAt).not.toBeNull()
  })

  test("completes the check as failed when a push deployment fails", async () => {
    await handler.handleWebhookEvent(makePushContext())

    mockUpdateCheckRun.mockReset()

    const groups = await db.select().from(runGroups)
    expect(groups).toHaveLength(1)

    const deployments = await db.select().from(previews)
    const jobs = await db.select().from(iacJobs)
    expect(deployments).toHaveLength(1)
    expect(jobs).toHaveLength(1)

    await updateDeploymentStatus(deployments[0].id, "failed")

    expect(mockUpdateCheckRun).toHaveBeenCalledTimes(1)
    expect(mockUpdateCheckRun).toHaveBeenCalledWith(0, "test-org", "test-repo", 123, {
      status: "completed",
      conclusion: "failure",
      detailsUrl:
        "https://yaffle.local:6969/app/test-org/test-repo/env/main?runGroupId=" + groups[0].id,
      title: "Failed",
      summary:
        `${getRunGroupCheckSummary("failure")}\n\n` +
        `[View more details at yaffle.local](https://yaffle.local:6969/app/test-org/test-repo/env/main?runGroupId=${groups[0].id})`,
    })
  })
})
