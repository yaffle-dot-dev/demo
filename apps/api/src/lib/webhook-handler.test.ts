import { afterAll, beforeEach, describe, expect, test } from "bun:test"

import type { RunType, TerraformResult, WebhookContext } from "@yaffle/shared"

import { db } from "./db.ts"
import { organizations, previews, tfRuns } from "../db/schema.ts"
import { KeyedMutex } from "./mutex.ts"
import { createHandler } from "./webhook-handler.ts"
import type { Runner, RunOpts } from "./runner.ts"

/** A fake runner that returns canned success results without cloning or running tofu. */
class FakeRunner implements Runner {
  calls: Array<{ command: RunType; owner: string; repo: string; stateKey: string }> = []

  async run(opts: RunOpts): Promise<TerraformResult> {
    this.calls.push({
      command: opts.command,
      owner: opts.owner,
      repo: opts.repo,
      stateKey: opts.stateKey,
    })

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

function makeContext(overrides?: Partial<WebhookContext>): WebhookContext {
  return {
    installationId: 0, // no real GitHub app, skips check run creation
    ownerGithubId: 99999,
    owner: "test-org",
    repo: "test-repo",
    prNumber: 42,
    action: "opened",
    headSha: "abc123def456",
    branch: "feature/test",
    merged: false,
    ...overrides,
  }
}

describe("webhook-handler", () => {
  let runner: FakeRunner
  let handler: ReturnType<typeof createHandler>

  beforeEach(async () => {
    await db.delete(tfRuns)
    await db.delete(previews)
    await db.delete(organizations)
    runner = new FakeRunner()
    handler = createHandler(runner)
  })

  afterAll(async () => {
    await db.delete(tfRuns)
    await db.delete(previews)
    await db.delete(organizations)
  })

  test("PR opened creates org, preview, and plan run", async () => {
    await handler.handlePullRequestEvent(makeContext({ action: "opened" }))

    // Verify org was created
    const orgs = await db.select().from(organizations)
    expect(orgs).toHaveLength(1)
    expect(orgs[0].login).toBe("test-org")
    expect(orgs[0].githubId).toBe(99999)

    // Verify preview was created
    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(1)
    expect(pvs[0].repo).toBe("test-repo")
    expect(pvs[0].prNumber).toBe(42)
    expect(pvs[0].headSha).toBe("abc123def456")
    expect(pvs[0].stateKey).toBe("previews/pr-42/terraform.tfstate")
    expect(pvs[0].status).toBe("ready")

    // Verify plan run was created and completed
    const runs = await db.select().from(tfRuns)
    expect(runs).toHaveLength(1)
    expect(runs[0].runType).toBe("plan")
    expect(runs[0].status).toBe("success")
    expect(runs[0].planSummary).toBe("+1, ~0, -0")
    expect(runs[0].startedAt).toBeTruthy()
    expect(runs[0].completedAt).toBeTruthy()

    // Verify runner was called with correct args including stateKey
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0].command).toBe("plan")
    expect(runner.calls[0].stateKey).toBe("previews/pr-42/terraform.tfstate")
  })

  test("PR synchronize updates head SHA and creates new plan run", async () => {
    await handler.handlePullRequestEvent(makeContext({ action: "opened", headSha: "sha-1" }))
    await handler.handlePullRequestEvent(makeContext({ action: "synchronize", headSha: "sha-2" }))

    // Preview should have updated SHA
    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(1)
    expect(pvs[0].headSha).toBe("sha-2")

    // Should have two plan runs
    const runs = await db.select().from(tfRuns)
    expect(runs).toHaveLength(2)
    expect(runs.every((r) => r.runType === "plan")).toBe(true)
    expect(runs.every((r) => r.status === "success")).toBe(true)

    expect(runner.calls).toHaveLength(2)
  })

  test("PR closed without merge creates destroy run", async () => {
    await handler.handlePullRequestEvent(makeContext({ action: "opened" }))
    await handler.handlePullRequestEvent(makeContext({ action: "closed", merged: false }))

    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(1)
    expect(pvs[0].status).toBe("destroyed")

    const runs = await db.select().from(tfRuns)
    const destroyRuns = runs.filter((r) => r.runType === "destroy")
    expect(destroyRuns).toHaveLength(1)
    expect(destroyRuns[0].status).toBe("success")

    expect(runner.calls.filter((c) => c.command === "destroy")).toHaveLength(1)
    expect(runner.calls.find((c) => c.command === "destroy")?.stateKey).toBe(
      "previews/pr-42/terraform.tfstate",
    )
  })

  test("PR merged creates apply + destroy runs", async () => {
    await handler.handlePullRequestEvent(makeContext({ action: "opened" }))
    await handler.handlePullRequestEvent(makeContext({ action: "closed", merged: true }))

    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(1)
    expect(pvs[0].status).toBe("destroyed")

    const runs = await db.select().from(tfRuns)
    const applyRuns = runs.filter((r) => r.runType === "apply")
    const destroyRuns = runs.filter((r) => r.runType === "destroy")
    expect(applyRuns).toHaveLength(1)
    expect(applyRuns[0].status).toBe("success")
    expect(destroyRuns).toHaveLength(1)
    expect(destroyRuns[0].status).toBe("success")

    expect(runner.calls.filter((c) => c.command === "apply")).toHaveLength(1)
    expect(runner.calls.filter((c) => c.command === "destroy")).toHaveLength(1)

    // Apply should target production state, destroy should target preview state
    const applyCall = runner.calls.find((c) => c.command === "apply")
    const destroyCall = runner.calls.find((c) => c.command === "destroy")
    expect(applyCall?.stateKey).toBe("production/main/terraform.tfstate")
    expect(destroyCall?.stateKey).toBe("previews/pr-42/terraform.tfstate")
  })

  test("PR closed with no existing preview is a no-op", async () => {
    await handler.handlePullRequestEvent(makeContext({ action: "closed", prNumber: 999 }))

    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(0)
    expect(runner.calls).toHaveLength(0)
  })

  test("reopened PR reuses existing preview", async () => {
    await handler.handlePullRequestEvent(makeContext({ action: "opened" }))
    await handler.handlePullRequestEvent(makeContext({ action: "closed", merged: false }))
    await handler.handlePullRequestEvent(makeContext({ action: "reopened", headSha: "new-sha" }))

    // Still only one preview record (upsert)
    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(1)
    expect(pvs[0].headSha).toBe("new-sha")
    expect(pvs[0].status).toBe("ready")

    // plan, destroy, plan
    expect(runner.calls.map((c) => c.command)).toEqual(["plan", "destroy", "plan"])
  })

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
    const failHandler = createHandler(failRunner)

    await failHandler.handlePullRequestEvent(makeContext({ action: "opened" }))

    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(1)
    expect(pvs[0].status).toBe("failed")

    const runs = await db.select().from(tfRuns)
    expect(runs).toHaveLength(1)
    expect(runs[0].status).toBe("failed")
    expect(runs[0].errorMessage).toBe("init failed")
  })

  test("concurrent events for same PR are serialized by mutex", async () => {
    const order: string[] = []
    let resolveFirst!: () => void
    const firstBlocked = new Promise<void>((r) => { resolveFirst = r })

    /** A slow runner that blocks the first call until we release it. */
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
    const slowHandler = createHandler(slowRunner, mutex)

    // Fire both events concurrently (simulating rapid pushes)
    const p1 = slowHandler.handlePullRequestEvent(
      makeContext({ action: "opened", headSha: "sha-1" }),
    )
    const p2 = slowHandler.handlePullRequestEvent(
      makeContext({ action: "synchronize", headSha: "sha-2" }),
    )

    // Give microtasks time to start
    await new Promise((r) => setTimeout(r, 50))

    // Only the first call should have started
    expect(order).toEqual(["start-1"])

    // Release the first call
    resolveFirst()
    await Promise.all([p1, p2])

    // Both completed in order: first finished, then second ran
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"])

    // Both plans should be in the DB
    const runs = await db.select().from(tfRuns)
    expect(runs).toHaveLength(2)
    expect(runs.every((r) => r.status === "success")).toBe(true)

    // Final preview headSha should be from the second event
    const pvs = await db.select().from(previews)
    expect(pvs).toHaveLength(1)
    expect(pvs[0].headSha).toBe("sha-2")
  })
})
