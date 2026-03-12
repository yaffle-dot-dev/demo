import { afterAll, beforeEach, describe, expect, test } from "bun:test"

import type {
  PullRequestContext,
  PushContext,
  RunType,
  TerraformResult,
  WebhookContext,
} from "@yaffle/shared"

import type { YaffleConfig } from "./config.ts"
import { sql } from "drizzle-orm"

import { db } from "./db.ts"
import { previews, tfRuns } from "../db/schema.ts"
import { KeyedMutex } from "./mutex.ts"
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

/** Minimal config with one workspace, auto_apply on. */
const DEFAULT_CONFIG: YaffleConfig = {
  version: 1,
  workspaces: [
    {
      path: "infra",
      auto_apply: true,
      auto_apply_on_merge: true,
      require_approval: false,
    },
  ],
}

/** Config with auto_apply disabled (plan only). */
const PLAN_ONLY_CONFIG: YaffleConfig = {
  version: 1,
  workspaces: [
    {
      path: "infra",
      auto_apply: false,
      auto_apply_on_merge: true,
      require_approval: false,
    },
  ],
}

/** Config with two workspaces. */
const MULTI_WORKSPACE_CONFIG: YaffleConfig = {
  version: 1,
  workspaces: [
    {
      path: "infra",
      auto_apply: true,
      auto_apply_on_merge: true,
      require_approval: false,
      variables: { environment: "{{ env }}" },
    },
    {
      path: "infra/monitoring",
      auto_apply: true,
      auto_apply_on_merge: true,
      require_approval: false,
      variables: { environment: "{{ env }}" },
    },
  ],
}

/** Config with approval required on merge. */
const APPROVAL_CONFIG: YaffleConfig = {
  version: 1,
  workspaces: [
    {
      path: "infra",
      auto_apply: true,
      auto_apply_on_merge: true,
      require_approval: true,
      approvers: ["lamalex"],
    },
  ],
}

/** Fake config loader that returns a fixed config. */
function fakeConfigLoader(config: YaffleConfig) {
  return async (_ctx: WebhookContext, _token?: string): Promise<YaffleConfig> => config
}

function makePrContext(overrides?: Partial<PullRequestContext>): PullRequestContext {
  return {
    kind: "pull_request",
    installationId: 0,
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
  return {
    kind: "push",
    installationId: 0,
    ownerGithubId: 99999,
    owner: "test-org",
    repo: "test-repo",
    headSha: "abc123def456",
    branch: "main",
    pusherGithubId: 12345,
    pusherLogin: "octocat",
    defaultBranch: "main",
    ...overrides,
  }
}

describe("webhook-handler", () => {
  let runner: FakeRunner
  let handler: ReturnType<typeof createHandler>

  beforeEach(async () => {
    // Use TRUNCATE CASCADE to properly handle all FK constraints
    // This is faster and more reliable than DELETE in order
    await db.execute(
      sql`TRUNCATE TABLE 
        tf_runs, 
        previews, 
        state_versions, 
        workspaces, 
        connections, 
        repositories, 
        github_installations, 
        organizations 
      CASCADE`
    )
    runner = new FakeRunner()
    handler = createHandler(runner, { configLoader: fakeConfigLoader(DEFAULT_CONFIG) })
  })

  afterAll(async () => {
    await db.execute(
      sql`TRUNCATE TABLE 
        tf_runs, 
        previews, 
        state_versions, 
        workspaces, 
        connections, 
        repositories, 
        github_installations, 
        organizations 
      CASCADE`
    )
  })

  // -----------------------------------------------------------------------
  // PR opened -- plan only (apply requires explicit trigger via UI)
  // -----------------------------------------------------------------------

  test("PR opened: plans and waits for apply approval", async () => {
    await handler.handleWebhookEvent(makePrContext({ action: "opened" }))

    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(1)
    expect(pvs[0].status).toBe("awaiting_apply") // Waits for UI approval
    expect(pvs[0].stateKey).toBe("preview-pr-42/infra/terraform.tfstate")

    const runs = await db.select().from(tfRuns)
    expect(runs).toHaveLength(1) // plan only - apply waits for explicit trigger
    const planRuns = runs.filter((r) => r.runType === "plan")
    expect(planRuns).toHaveLength(1)
    expect(planRuns[0].status).toBe("success")

    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0].command).toBe("plan")
    expect(runner.calls[0].workspacePath).toBe("infra")
  })

  // -----------------------------------------------------------------------
  // PR opened -- plan only (auto_apply: false config, same behavior as auto_apply: true now)
  // -----------------------------------------------------------------------

  test("PR opened: plan only when auto_apply is false", async () => {
    handler = createHandler(runner, { configLoader: fakeConfigLoader(PLAN_ONLY_CONFIG) })

    await handler.handleWebhookEvent(makePrContext({ action: "opened" }))

    const runs = await db.select().from(tfRuns)
    expect(runs).toHaveLength(1) // plan only
    expect(runs[0].runType).toBe("plan")
    expect(runs[0].status).toBe("success")

    const pvs = await db.select().from(previews)
    // With auto_apply: false, still waits for approval (same as auto_apply: true now)
    expect(pvs[0].status).toBe("awaiting_apply")

    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0].command).toBe("plan")
  })

  // -----------------------------------------------------------------------
  // PR synchronize
  // -----------------------------------------------------------------------

  test("PR synchronize: re-plans (apply requires explicit trigger)", async () => {
    await handler.handleWebhookEvent(makePrContext({ action: "opened", headSha: "sha-1" }))
    await handler.handleWebhookEvent(makePrContext({ action: "synchronize", headSha: "sha-2" }))

    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(1)
    expect(pvs[0].headSha).toBe("sha-2")
    expect(pvs[0].status).toBe("awaiting_apply")

    // 2 plans only - applies require explicit trigger
    const runs = await db.select().from(tfRuns)
    expect(runs).toHaveLength(2)

    expect(runner.calls).toHaveLength(2)
    expect(runner.calls[0].command).toBe("plan")
    expect(runner.calls[1].command).toBe("plan")
  })

  // -----------------------------------------------------------------------
  // PR closed without merge -- destroy preview
  // -----------------------------------------------------------------------

  test("PR closed without merge: destroys preview", async () => {
    await handler.handleWebhookEvent(makePrContext({ action: "opened" }))
    await handler.handleWebhookEvent(makePrContext({ action: "closed", merged: false }))

    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(1)
    expect(pvs[0].status).toBe("destroyed")

    const destroyRuns = (await db.select().from(tfRuns)).filter((r) => r.runType === "destroy")
    expect(destroyRuns).toHaveLength(1)
    expect(destroyRuns[0].status).toBe("success")
  })

  // -----------------------------------------------------------------------
  // PR merged -- destroy preview (production apply is via push event)
  // -----------------------------------------------------------------------

  test("PR merged: destroys preview only (no production apply)", async () => {
    await handler.handleWebhookEvent(makePrContext({ action: "opened" }))
    await handler.handleWebhookEvent(makePrContext({ action: "closed", merged: true }))

    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(1)
    expect(pvs[0].status).toBe("destroyed")

    // plan + apply (from open) + destroy (from close)
    const runs = await db.select().from(tfRuns)
    const applyRuns = runs.filter((r) => r.runType === "apply")
    const destroyRuns = runs.filter((r) => r.runType === "destroy")
    expect(applyRuns).toHaveLength(1) // preview apply only
    expect(destroyRuns).toHaveLength(1)

    // No production apply -- that comes from a push event
    expect(runner.calls.filter((c) => c.command === "apply")).toHaveLength(1)
    expect(runner.calls.find((c) => c.command === "apply")?.stateKey).toBe(
      "preview-pr-42/infra/terraform.tfstate",
    )
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
  // Reopened PR
  // -----------------------------------------------------------------------

  test("reopened PR reuses existing preview", async () => {
    await handler.handleWebhookEvent(makePrContext({ action: "opened" }))
    await handler.handleWebhookEvent(makePrContext({ action: "closed", merged: false }))
    await handler.handleWebhookEvent(makePrContext({ action: "reopened", headSha: "new-sha" }))

    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(1)
    expect(pvs[0].headSha).toBe("new-sha")
    expect(pvs[0].status).toBe("ready")
  })

  // -----------------------------------------------------------------------
  // Runner failure
  // -----------------------------------------------------------------------

  test("runner failure marks run and preview as failed", async () => {
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
    })

    await failHandler.handleWebhookEvent(makePrContext({ action: "opened" }))

    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(1)
    expect(pvs[0].status).toBe("failed")

    const runs = await db.select().from(tfRuns)
    expect(runs).toHaveLength(1) // only plan, no apply since plan failed
    expect(runs[0].status).toBe("failed")
    expect(runs[0].errorMessage).toBe("init failed")
  })

  // -----------------------------------------------------------------------
  // Multi-workspace
  // -----------------------------------------------------------------------

  test("multi-workspace: plans each workspace (apply requires explicit trigger)", async () => {
    handler = createHandler(runner, {
      configLoader: fakeConfigLoader(MULTI_WORKSPACE_CONFIG),
    })

    await handler.handleWebhookEvent(makePrContext({ action: "opened" }))

    // Two workspaces, each gets plan only = 2 runner calls (applies require explicit trigger)
    expect(runner.calls).toHaveLength(2)
    expect(runner.calls[0]).toMatchObject({ command: "plan", workspacePath: "infra" })
    expect(runner.calls[1]).toMatchObject({ command: "plan", workspacePath: "infra/monitoring" })
  })

  // -----------------------------------------------------------------------
  // Concurrent events serialized by mutex
  // -----------------------------------------------------------------------

  test("concurrent events for same PR are serialized by mutex", async () => {
    const order: string[] = []
    let resolveFirst!: () => void
    const firstBlocked = new Promise<void>((r) => { resolveFirst = r })

    const slowRunner: Runner = {
      calls: 0,
      async run(opts: RunOpts): Promise<TerraformResult> {
        const callNum = ++this.calls
        order.push(`start-${callNum}`)

        if (callNum === 1) {
          await firstBlocked
        }

        order.push(`end-${callNum}`)
        return {
          success: true,
          command: opts.command,
          output: `call ${callNum}`,
          planSummary: "+1, ~0, -0",
          durationMs: 1,
        }
      },
    } as Runner & { calls: number }

    const mutex = new KeyedMutex()
    const slowHandler = createHandler(slowRunner, {
      mutex,
      configLoader: fakeConfigLoader(PLAN_ONLY_CONFIG),
    })

    const p1 = slowHandler.handleWebhookEvent(
      makePrContext({ action: "opened", headSha: "sha-1" }),
    )
    const p2 = slowHandler.handleWebhookEvent(
      makePrContext({ action: "synchronize", headSha: "sha-2" }),
    )

    await new Promise((r) => setTimeout(r, 50))
    expect(order).toEqual(["start-1"])

    resolveFirst()
    await Promise.all([p1, p2])

    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"])
  })

  // -----------------------------------------------------------------------
  // Push to default branch -- production plan (apply requires UI approval)
  // -----------------------------------------------------------------------

  test("push to default branch: plans and waits for apply approval", async () => {
    await handler.handleWebhookEvent(makePushContext())

    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(1)
    expect(pvs[0].prNumber).toBe(0) // sentinel for production
    expect(pvs[0].stateKey).toBe("main/infra/terraform.tfstate")
    expect(pvs[0].status).toBe("awaiting_apply") // Waits for UI timer/approval

    const runs = await db.select().from(tfRuns)
    expect(runs).toHaveLength(1) // plan only - apply waits for explicit trigger
    expect(runs[0].runType).toBe("plan")

    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0].command).toBe("plan")
    expect(runner.calls[0].stateKey).toBe("main/infra/terraform.tfstate")
  })

  test("push to default branch with require_approval plans only", async () => {
    const runner = new FakeRunner()
    const h = createHandler(runner, { configLoader: fakeConfigLoader(APPROVAL_CONFIG) })

    await h.handleWebhookEvent(makePushContext())

    // Only plan should run
    expect(runner.calls.map((c) => c.command)).toEqual(["plan"])

    const previewRows = await db.select().from(previews)
    expect(previewRows).toHaveLength(1)
    // Both require_approval: true and false now wait - difference is UI shows timer vs button
    expect(previewRows[0].status).toBe("awaiting_apply")
    expect(previewRows[0].requireApproval).toBe(true)
  })

  // -----------------------------------------------------------------------
  // Push to non-default branch -- ignored
  // -----------------------------------------------------------------------

  test("push to non-default branch is ignored", async () => {
    await handler.handleWebhookEvent(makePushContext({ branch: "feature/something" }))

    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(0)
    expect(runner.calls).toHaveLength(0)
  })

  // -----------------------------------------------------------------------
  // Config default_branch override
  // -----------------------------------------------------------------------

  test("push respects config default_branch override", async () => {
    const config: YaffleConfig = {
      version: 1,
      default_branch: "develop",
      workspaces: [{ path: "infra", auto_apply: true, auto_apply_on_merge: true, require_approval: false }],
    }
    const h = createHandler(runner, { configLoader: fakeConfigLoader(config) })

    // Push to "main" should be ignored because config says "develop"
    await h.handleWebhookEvent(makePushContext({ branch: "main", defaultBranch: "main" }))
    expect(runner.calls).toHaveLength(0)

    // Push to "develop" should trigger
    await h.handleWebhookEvent(makePushContext({ branch: "develop", defaultBranch: "main" }))
    expect(runner.calls).toHaveLength(2) // plan + apply
  })

  // -----------------------------------------------------------------------
  // Config error -- should not crash, should not call runner
  // -----------------------------------------------------------------------

  test("config error does not crash and skips runner calls", async () => {
    const failingLoader = async () => {
      throw new Error("config file not found")
    }
    const h = createHandler(runner, { configLoader: failingLoader })

    // Should not throw
    await h.handleWebhookEvent(makePrContext({ action: "opened" }))

    // No runner calls -- config failed before any runs
    expect(runner.calls).toHaveLength(0)

    // No previews created
    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(0)
  })

  // -----------------------------------------------------------------------
  // Multi-workspace: each workspace gets its own preview record
  // -----------------------------------------------------------------------

  test("multi-workspace: creates separate preview records per workspace", async () => {
    handler = createHandler(runner, {
      configLoader: fakeConfigLoader(MULTI_WORKSPACE_CONFIG),
    })

    await handler.handleWebhookEvent(makePrContext({ action: "opened" }))

    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(2)

    const paths = pvs.map((p) => p.workspacePath).sort()
    expect(paths).toEqual(["infra", "infra/monitoring"])

    // Each preview has its own state key
    const stateKeys = pvs.map((p) => p.stateKey).sort()
    expect(stateKeys).toEqual([
      "preview-pr-42/infra/monitoring/terraform.tfstate",
      "preview-pr-42/infra/terraform.tfstate",
    ])
  })
})
