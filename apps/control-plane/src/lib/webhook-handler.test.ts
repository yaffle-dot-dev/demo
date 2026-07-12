import { afterAll, beforeEach, describe, expect, test } from "@yaffle/test"

import type {
  PullRequestContext,
  PushContext,
  RunType,
  TerraformResult,
  WebhookContext,
} from "@yaffle/shared"

import type { YaffleTomlConfig } from "./config-toml.ts"
import { sql } from "drizzle-orm"

import { db } from "./db.ts"
import { createGithubInstallation, createOrg } from "../db/queries/organizations.ts"
import { setRepoMapping } from "../db/queries/repo-mappings.ts"
import { getJobWithContext } from "../db/queries/iac-jobs.ts"
import { claimScanJob, completeScanJob, createScanJob } from "../db/queries/scan-jobs.ts"
import { iacJobHistory, iacJobs, previews, runGroups } from "../db/schema.ts"
import { KeyedMutex } from "./mutex.ts"
import { completeRunGroup } from "./run-group-orchestrator.ts"
import { createHandler } from "./webhook-handler.ts"
import type { Runner, RunOpts } from "./runner.ts"

/** A fake runner that records calls and returns canned results. */
class FakeRunner implements Runner {
  calls: Array<{
    command: RunType
    owner: string
    repo: string
    workspacePath: string
    stateKey: string
  }> = []

  async run(opts: RunOpts): Promise<TerraformResult> {
    this.calls.push({
      command: opts.command,
      owner: opts.owner,
      repo: opts.repo,
      workspacePath: opts.workspacePath,
      stateKey: opts.stateKey,
    })

    opts.onOutput?.(`fake ${opts.command} output`, "stdout")

    return {
      success: true,
      command: opts.command,
      output: `fake ${opts.command} output`,
      planSummary: opts.command === "plan" ? "+1, ~0, -0" : undefined,
      planJson: opts.command === "plan" ? { fake: true } : undefined,
      outputs: opts.command === "apply" ? { id: { value: "test-123" } } : undefined,
      durationMs: 42,
    }
  }
}

/** Helper to get queued jobs from the database */
async function getQueuedJobs() {
  return db
    .select()
    .from(iacJobs)
    .where(sql`${iacJobs.status} = 'queued'`)
}

/** Helper to get all jobs from the database */
async function getAllJobs() {
  const [activeJobs, historicalJobs] = await Promise.all([
    db.select().from(iacJobs),
    db.select().from(iacJobHistory),
  ])

  return [...activeJobs, ...historicalJobs]
}

/** Minimal config with one workspace for both PR and push. */
const DEFAULT_CONFIG: YaffleTomlConfig = {
  version: 1,
  environments: [{ name: "main" }],
  workspaces: [
    {
      path: "infra",
      environments: "*", // Matches all environments (both named and transient)
      automaticPreviewIsolation: false,
    },
  ],
  cloud: {
    triggers: {
      github: {
        push: [
          { ref_patterns: ["refs/heads/main"], exclude_ref_patterns: [], environment: "main" },
        ],
        pull_request: [{ branch_patterns: ["*"], exclude_branch_patterns: [] }],
      },
    },
    approvals: [],
  },
}

/** Config with two workspaces. */
const MULTI_WORKSPACE_CONFIG: YaffleTomlConfig = {
  version: 1,
  environments: [{ name: "main" }],
  workspaces: [
    {
      path: "infra",
      environments: "*",
      automaticPreviewIsolation: false,
      variables: { region: "us-east-1" },
    },
    {
      path: "infra/monitoring",
      environments: "*",
      automaticPreviewIsolation: false,
      variables: { region: "us-east-1" },
    },
  ],
  cloud: {
    triggers: {
      github: {
        push: [
          { ref_patterns: ["refs/heads/main"], exclude_ref_patterns: [], environment: "main" },
        ],
        pull_request: [{ branch_patterns: ["*"], exclude_branch_patterns: [] }],
      },
    },
    approvals: [],
  },
}

/** Config with approval required for main environment. */
const APPROVAL_CONFIG: YaffleTomlConfig = {
  version: 1,
  environments: [{ name: "main" }],
  workspaces: [
    {
      path: "infra",
      environments: "*",
      automaticPreviewIsolation: false,
    },
  ],
  cloud: {
    triggers: {
      github: {
        push: [
          { ref_patterns: ["refs/heads/main"], exclude_ref_patterns: [], environment: "main" },
        ],
        pull_request: [{ branch_patterns: ["*"], exclude_branch_patterns: [] }],
      },
    },
    approvals: [
      {
        workspaces: ["infra"],
        environments: ["main"],
        approvers: ["github:user:lamalex"],
      },
    ],
  },
}

/** Fake config loader that returns a fixed config. */
function fakeConfigLoader(config: YaffleTomlConfig) {
  return async (_ctx: WebhookContext, _token?: string): Promise<YaffleTomlConfig> => config
}

let lastAutomaticIsolationWorkspacePaths: string[] = []

async function fakeScanDispatcher(
  ctx: WebhookContext,
  orgId: string,
  orgSlug: string,
  runGroupId: string,
  workspacePaths: string[],
  workspaceVariables: Record<string, Record<string, string | number | boolean>>,
  automaticIsolationWorkspacePaths: string[],
  installationToken?: string,
): Promise<void> {
  lastAutomaticIsolationWorkspacePaths = automaticIsolationWorkspacePaths
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
    automaticIsolationWorkspacePaths,
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

/**
 * Safety check - refuse to run destructive operations on non-test database.
 */
function assertTestDatabase(): void {
  const dbUrl = process.env.DATABASE_URL ?? ""
  if (!dbUrl.includes("_test")) {
    throw new Error(
      `FATAL: Test attempted to truncate tables but DATABASE_URL doesn't contain '_test'. ` +
        `Refusing to run. Set DATABASE_URL to yaffle_test before running tests. ` +
        `Current URL: ${dbUrl.replace(/\/\/[^@]+@/, "//***@")}`,
    )
  }
}

describe("webhook-handler", () => {
  let runner: FakeRunner
  let handler: ReturnType<typeof createHandler>

  beforeEach(async () => {
    // Safety check - refuse to truncate production/dev database
    assertTestDatabase()
    lastAutomaticIsolationWorkspacePaths = []

    // Use TRUNCATE CASCADE to properly handle all FK constraints
    // This is faster and more reliable than DELETE in order
    await db.execute(
      sql`TRUNCATE TABLE 
        iac_jobs,
        tf_runs, 
        workspace_deployments, 
        state_versions, 
        workspaces, 
        connections, 
        repositories, 
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

    runner = new FakeRunner()
    handler = createHandler(runner, {
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
        state_versions, 
        workspaces, 
        connections, 
        repositories, 
        github_installations, 
        organizations 
      CASCADE`,
    )
  })

  // -----------------------------------------------------------------------
  // PR opened -- queues plan job (execution happens via IaC engine)
  // -----------------------------------------------------------------------

  test("PR opened: creates preview and queues plan job", async () => {
    await handler.handleWebhookEvent(makePrContext({ action: "opened" }))

    // Preview is created in pending state (waiting for plan job to run)
    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(1)
    expect(pvs[0].status).toBe("pending")
    expect(pvs[0].stateKey).toBe("transient-pr-42/infra/terraform.tfstate")
    expect(pvs[0].runGroupId).not.toBeNull()

    // Plan job is queued (not executed inline)
    const jobs = await getQueuedJobs()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].jobType).toBe("plan")
    expect(jobs[0].deploymentId).toBe(pvs[0].id)

    const groups = await db.select().from(runGroups)
    expect(groups).toHaveLength(1)
    expect(groups[0].repoBindingId).toBeTruthy()
    expect(groups[0].selectedWorkspacePaths).toEqual(["infra"])
    expect(groups[0].executionSnapshot).toMatchObject({
      version: 1,
      source: {
        installationId: 0,
        repositoryId: 123456,
        ownerId: 99999,
        owner: "test-org",
        repository: "test-repo",
        ref: "refs/heads/feature/test",
        commitSha: "abc123def456",
        actor: {
          githubId: 12345,
          login: "octocat",
        },
      },
      configuration: {
        path: "yaffle.toml",
        revision: "abc123def456",
      },
      environment: {
        kind: "transient",
        name: "pr-42",
        sourcePullRequestNumber: 42,
      },
      workspaces: [
        {
          path: "infra",
          variables: {},
          approval: { required: false, approvers: [] },
          lifecycle: { activation: [], verification: [] },
          automaticPreviewIsolation: false,
        },
      ],
    })

    // Runner is NOT called - execution happens via IaC engine
    expect(runner.calls).toHaveLength(0)
    expect(lastAutomaticIsolationWorkspacePaths).toEqual([])
  })

  test("later repository config does not mutate an existing run or job", async () => {
    let config: YaffleTomlConfig = {
      ...DEFAULT_CONFIG,
      workspaces: [
        {
          ...DEFAULT_CONFIG.workspaces[0],
          variables: { release: "first" },
          activation: [
            {
              key: "deploy",
              environments: ["*"],
              kind: "generic",
              failure: "failed",
              scopes: [],
              request: { url: "https://first.example.test/deploy", method: "POST" },
            },
          ],
        },
      ],
      cloud: {
        ...DEFAULT_CONFIG.cloud,
        approvals: [
          {
            workspaces: ["infra"],
            environments: ["*"],
            approvers: ["github:user:first-reviewer"],
          },
        ],
      },
    }
    handler = createHandler(runner, {
      configLoader: async () => config,
      scanDispatcher: fakeScanDispatcher,
    })

    await handler.handleWebhookEvent(makePrContext({ headSha: "sha-first" }))

    const firstGroup = (await db.select().from(runGroups)).find(
      (group) => group.headSha === "sha-first",
    )
    const firstJob = (await getQueuedJobs())[0]
    expect(firstGroup).toBeDefined()
    expect(firstJob).toBeDefined()

    config = {
      ...config,
      workspaces: [
        {
          ...config.workspaces[0],
          variables: { release: "second" },
          activation: [
            {
              key: "deploy",
              environments: ["*"],
              kind: "generic",
              failure: "failed",
              scopes: [],
              request: { url: "https://second.example.test/deploy", method: "POST" },
            },
          ],
        },
      ],
    }
    await handler.handleWebhookEvent(makePrContext({
      action: "synchronize",
      headSha: "sha-second",
    }))

    const persistedFirstGroup = (await db.select().from(runGroups)).find(
      (group) => group.id === firstGroup?.id,
    )
    expect(persistedFirstGroup?.executionSnapshot).toMatchObject({
      source: { commitSha: "sha-first" },
      configuration: { revision: "sha-first" },
      workspaces: [
        {
          path: "infra",
          variables: { release: "first" },
          approval: {
            required: true,
            approvers: ["github:user:first-reviewer"],
          },
          lifecycle: {
            activation: [
              {
                key: "deploy",
                request: { url: "https://first.example.test/deploy" },
              },
            ],
          },
        },
      ],
    })

    const firstJobContext = await getJobWithContext(firstJob.id)
    expect(firstJobContext?.runGroup?.id).toBe(firstGroup?.id)
    expect(firstJobContext?.runGroup?.executionSnapshot).toEqual(
      persistedFirstGroup?.executionSnapshot,
    )
  })

  test("PR opened: propagates automatic isolation only for opted-in transient workspaces", async () => {
    handler = createHandler(runner, {
      configLoader: fakeConfigLoader({
        ...DEFAULT_CONFIG,
        workspaces: DEFAULT_CONFIG.workspaces.map((workspace) => ({
          ...workspace,
          automaticPreviewIsolation: true,
        })),
      }),
      scanDispatcher: fakeScanDispatcher,
    })

    await handler.handleWebhookEvent(makePrContext({ action: "opened" }))

    expect(lastAutomaticIsolationWorkspacePaths).toEqual(["infra"])
  })

  // -----------------------------------------------------------------------
  // PR opened -- with multi-workspace config
  // -----------------------------------------------------------------------

  test("PR opened: queues plan jobs for all matching workspaces", async () => {
    handler = createHandler(runner, {
      configLoader: fakeConfigLoader(MULTI_WORKSPACE_CONFIG),
      scanDispatcher: fakeScanDispatcher,
    })

    await handler.handleWebhookEvent(makePrContext({ action: "opened" }))

    // Preview created for each workspace
    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(2)
    expect(pvs.every((p) => p.status === "pending")).toBe(true)

    // Plan job is queued for each workspace
    const jobs = await getQueuedJobs()
    expect(jobs).toHaveLength(2)
    expect(jobs.every((j) => j.jobType === "plan")).toBe(true)

    // No inline execution
    expect(runner.calls).toHaveLength(0)
  })

  // -----------------------------------------------------------------------
  // PR synchronize -- queues new plan job
  // -----------------------------------------------------------------------

  test("PR synchronize: re-queues plan job for new SHA", async () => {
    await handler.handleWebhookEvent(makePrContext({ action: "opened", headSha: "sha-1" }))
    await handler.handleWebhookEvent(makePrContext({ action: "synchronize", headSha: "sha-2" }))

    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(1)
    expect(pvs[0].headSha).toBe("sha-2")
    expect(pvs[0].status).toBe("pending") // Reset to pending for new plan

    // 2 plan jobs queued (one per event)
    const jobs = await getAllJobs()
    const planJobs = jobs.filter((j) => j.jobType === "plan")
    expect(planJobs).toHaveLength(2)

    // No inline execution
    expect(runner.calls).toHaveLength(0)
  })

  // -----------------------------------------------------------------------
  // PR closed without merge -- queues destroy job
  // -----------------------------------------------------------------------

  test("PR closed without merge: queues destroy job", async () => {
    await handler.handleWebhookEvent(makePrContext({ action: "opened" }))
    await handler.handleWebhookEvent(makePrContext({ action: "closed", merged: false }))

    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(1)
    // Status is "pending" because destroy job is queued, not executed
    expect(pvs[0].status).toBe("pending")

    // Destroy job is queued (not executed inline)
    const jobs = await getAllJobs()
    const destroyJobs = jobs.filter((j) => j.jobType === "destroy")
    expect(destroyJobs).toHaveLength(1)
    expect(destroyJobs[0].status).toBe("queued")

    // No inline execution - runner is not called
    expect(runner.calls.filter((c) => c.command === "destroy")).toHaveLength(0)
  })

  // -----------------------------------------------------------------------
  // PR merged -- queues destroy job (production apply is via push event)
  // -----------------------------------------------------------------------

  test("PR merged: queues destroy job only (no production apply)", async () => {
    await handler.handleWebhookEvent(makePrContext({ action: "opened" }))
    await handler.handleWebhookEvent(makePrContext({ action: "closed", merged: true }))

    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(1)
    // Status is "pending" because destroy job is queued, not executed
    expect(pvs[0].status).toBe("pending")

    // Destroy job is queued (execution happens via IaC engine)
    const jobs = await getAllJobs()
    const destroyJobs = jobs.filter((j) => j.jobType === "destroy")
    expect(destroyJobs).toHaveLength(1)
    expect(destroyJobs[0].status).toBe("queued")

    // No inline execution - runner is not called
    expect(runner.calls.filter((c) => c.command === "destroy")).toHaveLength(0)
  })

  // -----------------------------------------------------------------------
  // PR closed with no existing preview
  // -----------------------------------------------------------------------

  test("PR closed with no existing preview is a no-op", async () => {
    await handler.handleWebhookEvent(makePrContext({ action: "closed", prNumber: 999 }))

    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(0)
    // Config is loaded but no preview found, so no runner calls
    expect(runner.calls).toHaveLength(0)
  })

  // -----------------------------------------------------------------------
  // Reopened PR - cancels destroy job and queues new plan job
  // -----------------------------------------------------------------------

  test("reopened PR reuses existing preview and queues plan", async () => {
    await handler.handleWebhookEvent(makePrContext({ action: "opened" }))
    await handler.handleWebhookEvent(makePrContext({ action: "closed", merged: false }))
    await handler.handleWebhookEvent(makePrContext({ action: "reopened", headSha: "new-sha" }))

    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(1)
    expect(pvs[0].headSha).toBe("new-sha")
    expect(pvs[0].status).toBe("pending") // Reset to pending for new plan job

    // Check job history:
    // 1. Open: creates plan job (queued)
    // 2. Close: cancels plan job, creates destroy job (queued)
    // 3. Reopen: cancels destroy job, creates new plan job (queued)
    const jobs = await getAllJobs()
    const planJobs = jobs.filter((j) => j.jobType === "plan")
    const destroyJobs = jobs.filter((j) => j.jobType === "destroy")

    // 2 plan jobs total: one cancelled (from open), one queued (from reopen)
    expect(planJobs).toHaveLength(2)
    expect(planJobs.filter((j) => j.status === "cancelled")).toHaveLength(1)
    expect(planJobs.filter((j) => j.status === "queued")).toHaveLength(1)

    // 1 destroy job: cancelled by reopen
    expect(destroyJobs).toHaveLength(1)
    expect(destroyJobs[0].status).toBe("cancelled")
  })

  // -----------------------------------------------------------------------
  // Runner failure - N/A for job-based execution (tested in IaC engine)
  // -----------------------------------------------------------------------

  test("job is queued even with failing runner (execution happens later)", async () => {
    // With job-based execution, the webhook handler just queues jobs
    // The runner is not called during webhook handling
    const failRunner: Runner = {
      async run(_opts: RunOpts) {
        return {
          success: false,
          command: "plan" as const,
          output: "something went wrong",
          errorMessage: "init failed",
          durationMs: 10,
        }
      },
    }
    const failHandler = createHandler(failRunner, {
      configLoader: fakeConfigLoader(DEFAULT_CONFIG),
      scanDispatcher: fakeScanDispatcher,
    })

    await failHandler.handleWebhookEvent(makePrContext({ action: "opened" }))

    // Preview is created in pending state
    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(1)
    expect(pvs[0].status).toBe("pending") // Not failed - job hasn't run yet

    // Job is queued
    const jobs = await getQueuedJobs()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].jobType).toBe("plan")

    // Runner is not called during webhook handling
    // (It would be called by IaC engine when job executes)
  })

  // -----------------------------------------------------------------------
  // Multi-workspace - queues plan jobs for each root workspace
  // -----------------------------------------------------------------------

  test("multi-workspace: queues plan job for each workspace", async () => {
    handler = createHandler(runner, {
      configLoader: fakeConfigLoader(MULTI_WORKSPACE_CONFIG),
      scanDispatcher: fakeScanDispatcher,
    })

    await handler.handleWebhookEvent(makePrContext({ action: "opened" }))

    // Two previews created
    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(2)

    // Plan jobs queued for each workspace
    const jobs = await getQueuedJobs()
    expect(jobs).toHaveLength(2)
    expect(jobs.map((j) => j.jobType)).toEqual(["plan", "plan"])

    // Runner is NOT called - execution happens via IaC engine
    expect(runner.calls).toHaveLength(0)
  })

  // -----------------------------------------------------------------------
  // Concurrent events serialized by mutex
  // -----------------------------------------------------------------------

  test("concurrent events for same PR are serialized by mutex", async () => {
    // With job-based execution, the webhook handler just queues jobs
    // The mutex ensures the events are processed in order
    const mutex = new KeyedMutex()
    const testHandler = createHandler(runner, {
      mutex,
      configLoader: fakeConfigLoader(DEFAULT_CONFIG),
      scanDispatcher: fakeScanDispatcher,
    })

    const p1 = testHandler.handleWebhookEvent(makePrContext({ action: "opened", headSha: "sha-1" }))
    const p2 = testHandler.handleWebhookEvent(
      makePrContext({ action: "synchronize", headSha: "sha-2" }),
    )

    await Promise.all([p1, p2])

    // Both events should complete (even if overlapping)
    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(1)
    // Last SHA wins
    expect(pvs[0].headSha).toBe("sha-2")

    // Two plan jobs queued
    const jobs = await getAllJobs()
    expect(jobs.filter((j) => j.jobType === "plan")).toHaveLength(2)
  })

  // -----------------------------------------------------------------------
  // Push to default branch -- queues production plan job
  // -----------------------------------------------------------------------

  test("push to default branch: queues plan job for production", async () => {
    await handler.handleWebhookEvent(makePushContext())

    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(1)
    expect(pvs[0].prNumber).toBeNull() // null for named environments (production)
    expect(pvs[0].environmentKind).toBe("named")
    expect(pvs[0].environmentName).toBe("main")
    expect(pvs[0].stateKey).toBe("named-main/infra/terraform.tfstate")
    expect(pvs[0].status).toBe("pending") // Waiting for plan job to run

    // Plan job queued
    const jobs = await getQueuedJobs()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].jobType).toBe("plan")

    const groups = await db.select().from(runGroups)
    expect(groups).toHaveLength(1)
    expect(groups[0].repoBindingId).toBeTruthy()
    expect(groups[0].selectedWorkspacePaths).toEqual(["infra"])

    // Runner NOT called - execution via IaC engine
    expect(runner.calls).toHaveLength(0)
  })

  test("push to default branch with require_approval queues plan job", async () => {
    const testRunner = new FakeRunner()
    const h = createHandler(testRunner, {
      configLoader: fakeConfigLoader(APPROVAL_CONFIG),
      scanDispatcher: fakeScanDispatcher,
    })

    await h.handleWebhookEvent(makePushContext())

    // No runner calls - job-based execution
    expect(testRunner.calls).toHaveLength(0)

    const previewRows = await db.select().from(previews)
    expect(previewRows).toHaveLength(1)
    expect(previewRows[0].status).toBe("pending")

    // Plan job queued
    const jobs = await getQueuedJobs()
    expect(jobs).toHaveLength(1)
  })

  // -----------------------------------------------------------------------
  // Push to non-default branch -- ignored
  // -----------------------------------------------------------------------

  test("push to non-matching ref is ignored", async () => {
    await handler.handleWebhookEvent(makePushContext({ ref: "refs/heads/feature/something" }))

    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(0)

    const jobs = await getAllJobs()
    expect(jobs).toHaveLength(0)

    expect(runner.calls).toHaveLength(0)
  })

  // -----------------------------------------------------------------------
  // Push trigger environment matching
  // -----------------------------------------------------------------------

  test("push respects trigger ref configuration", async () => {
    const config: YaffleTomlConfig = {
      version: 1,
      environments: [{ name: "develop" }],
      workspaces: [
        {
          path: "infra",
          environments: ["develop"],
          automaticPreviewIsolation: false,
        },
      ],
      cloud: {
        triggers: {
          github: {
            push: [
              {
                ref_patterns: ["refs/heads/develop"],
                exclude_ref_patterns: [],
                environment: "develop",
              },
            ],
            pull_request: [{ branch_patterns: ["*"], exclude_branch_patterns: [] }],
          },
        },
        approvals: [],
      },
    }
    const h = createHandler(runner, {
      configLoader: fakeConfigLoader(config),
      scanDispatcher: fakeScanDispatcher,
    })

    // Push to "main" should be ignored because no trigger matches
    await h.handleWebhookEvent(makePushContext({ ref: "refs/heads/main", defaultBranch: "main" }))
    expect(runner.calls).toHaveLength(0)
    let jobs = await getAllJobs()
    expect(jobs).toHaveLength(0)

    // Push to "develop" should queue plan job
    await h.handleWebhookEvent(
      makePushContext({ ref: "refs/heads/develop", defaultBranch: "main" }),
    )
    // Runner NOT called - job-based
    expect(runner.calls).toHaveLength(0)
    jobs = await getAllJobs()
    expect(jobs.filter((j) => j.jobType === "plan")).toHaveLength(1)
  })

  // -----------------------------------------------------------------------
  // Config error -- should not crash, should not call runner
  // -----------------------------------------------------------------------

  test("config error does not crash and skips job queueing", async () => {
    const failingLoader = async () => {
      throw new Error("config file not found")
    }
    const h = createHandler(runner, {
      configLoader: failingLoader,
      scanDispatcher: fakeScanDispatcher,
    })

    // Should not throw
    await h.handleWebhookEvent(makePrContext({ action: "opened" }))

    // No runner calls
    expect(runner.calls).toHaveLength(0)

    // No previews created
    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(0)

    // No jobs queued
    const jobs = await getAllJobs()
    expect(jobs).toHaveLength(0)
  })

  // -----------------------------------------------------------------------
  // Multi-workspace: each workspace gets its own preview record
  // -----------------------------------------------------------------------

  test("multi-workspace: creates separate preview records per workspace", async () => {
    handler = createHandler(runner, {
      configLoader: fakeConfigLoader(MULTI_WORKSPACE_CONFIG),
      scanDispatcher: fakeScanDispatcher,
    })

    await handler.handleWebhookEvent(makePrContext({ action: "opened" }))

    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(2)

    const paths = pvs.map((p) => p.workspacePath).sort()
    expect(paths).toEqual(["infra", "infra/monitoring"])

    // Each preview has its own state key
    const stateKeys = pvs.map((p) => p.stateKey).sort()
    expect(stateKeys).toEqual([
      "transient-pr-42/infra/monitoring/terraform.tfstate",
      "transient-pr-42/infra/terraform.tfstate",
    ])

    // Each workspace gets a plan job queued
    const jobs = await getQueuedJobs()
    expect(jobs).toHaveLength(2)
  })
})
