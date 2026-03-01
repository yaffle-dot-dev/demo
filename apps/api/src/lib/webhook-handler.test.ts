import { afterAll, beforeEach, describe, expect, test } from "bun:test"

import type { RunType, TerraformResult, WebhookContext } from "@yaffle/shared"

import { db } from "./db.ts"
import { organizations, previews, tfRuns } from "../db/schema.ts"
import { createHandler } from "./webhook-handler.ts"
import type { Runner } from "./runner.ts"

/** A fake runner that returns canned success results without cloning or running tofu. */
class FakeRunner implements Runner {
  calls: Array<{ command: RunType; owner: string; repo: string }> = []

  async run(opts: {
    owner: string
    repo: string
    headSha: string
    command: RunType
    variables?: Record<string, string>
  }): Promise<TerraformResult> {
    this.calls.push({ command: opts.command, owner: opts.owner, repo: opts.repo })

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

    // Verify runner was called with correct args
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0].command).toBe("plan")
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
      async run() {
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
})
