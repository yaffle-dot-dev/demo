import { describe, expect, test } from "bun:test"

import {
  type PrCommentContext,
  type WorkspaceState,
  PrCommentManager,
  NoopCommentManager,
  checkRunUrl,
  createCommentManager,
  renderComment,
} from "./pr-comment.ts"

const SHA = "abc123def456"
const SHORT_SHA = "abc123d"

const CTX: PrCommentContext = {
  installationId: 12345,
  owner: "lamalex",
  repo: "yaffle",
  prNumber: 42,
  headSha: SHA,
}

const planCheck = { id: 111, url: "https://github.com/lamalex/yaffle/runs/111" }
const applyCheck = { id: 222, url: "https://github.com/lamalex/yaffle/runs/222" }

// ---------------------------------------------------------------------------
// checkRunUrl
// ---------------------------------------------------------------------------

describe("checkRunUrl", () => {
  test("builds correct URL", () => {
    expect(checkRunUrl("lamalex", "yaffle", 12345)).toBe(
      "https://github.com/lamalex/yaffle/runs/12345",
    )
  })
})

// ---------------------------------------------------------------------------
// renderComment
// ---------------------------------------------------------------------------

describe("renderComment", () => {
  test("renders single workspace planning", () => {
    const ws = new Map<string, WorkspaceState>()
    ws.set("infra", { phase: "planning" })

    const result = renderComment(SHA, ws)

    expect(result).toContain("<!-- yaffle:pr -->")
    expect(result).toContain(`### Yaffle \`${SHORT_SHA}\``)
    expect(result).toContain("| `infra` |")
    expect(result).toContain("Planning...")
  })

  test("renders single workspace ready with outputs", () => {
    const ws = new Map<string, WorkspaceState>()
    ws.set("infra", {
      phase: "ready",
      planSummary: "+1, ~0, -0",
      outputs: {
        cluster_arn: { value: "arn:aws:ecs:us-east-1:123:cluster/app", type: "string" },
        env: { value: "preview-pr-42", type: "string" },
      },
      planCheckRun: planCheck,
      applyCheckRun: applyCheck,
    })

    const result = renderComment(SHA, ws)

    // Status table
    expect(result).toContain("| `infra` |")
    expect(result).toContain("Preview ready")
    expect(result).toContain("[Plan](https://github.com/lamalex/yaffle/runs/111)")
    expect(result).toContain("[Apply](https://github.com/lamalex/yaffle/runs/222)")

    // Outputs section
    expect(result).toContain("<code>infra</code> outputs")
    expect(result).toContain("| `cluster_arn` | `arn:aws:ecs:us-east-1:123:cluster/app` |")
    expect(result).toContain("| `env` | `preview-pr-42` |")
  })

  test("renders multi-workspace with mixed states", () => {
    const ws = new Map<string, WorkspaceState>()
    ws.set("infra", {
      phase: "ready",
      outputs: { id: { value: "abc", type: "string" } },
      planCheckRun: planCheck,
      applyCheckRun: applyCheck,
    })
    ws.set("infra/monitoring", {
      phase: "applying",
      planSummary: "+2, ~0, -0",
      planCheckRun: { id: 333, url: "https://github.com/lamalex/yaffle/runs/333" },
    })

    const result = renderComment(SHA, ws)

    // Both workspaces in status table
    expect(result).toContain("| `infra` |")
    expect(result).toContain("| `infra/monitoring` |")
    expect(result).toContain("Preview ready")
    expect(result).toContain("Applying")

    // Only infra has outputs section (monitoring is still applying)
    expect(result).toContain("<code>infra</code> outputs")
    expect(result).not.toContain("<code>infra/monitoring</code> outputs")
  })

  test("renders root workspace as 'root'", () => {
    const ws = new Map<string, WorkspaceState>()
    ws.set(".", { phase: "planning" })

    const result = renderComment(SHA, ws)
    expect(result).toContain("| `root` |")
  })

  test("masks sensitive outputs", () => {
    const ws = new Map<string, WorkspaceState>()
    ws.set("infra", {
      phase: "ready",
      outputs: {
        db_password: { value: "s3cret!", type: "string", sensitive: true },
        db_host: { value: "rds.example.com", type: "string" },
      },
    })

    const result = renderComment(SHA, ws)

    expect(result).toContain("*(sensitive)*")
    expect(result).not.toContain("s3cret!")
    expect(result).toContain("`rds.example.com`")
  })

  test("sorts outputs alphabetically", () => {
    const ws = new Map<string, WorkspaceState>()
    ws.set("infra", {
      phase: "ready",
      outputs: {
        zebra: { value: "z", type: "string" },
        alpha: { value: "a", type: "string" },
      },
    })

    const result = renderComment(SHA, ws)
    const alphaIdx = result.indexOf("`alpha`")
    const zebraIdx = result.indexOf("`zebra`")
    expect(alphaIdx).toBeLessThan(zebraIdx)
  })

  test("plan_failed shows error", () => {
    const ws = new Map<string, WorkspaceState>()
    ws.set("infra", {
      phase: "plan_failed",
      errorMessage: "provider not configured",
      planCheckRun: planCheck,
    })

    const result = renderComment(SHA, ws)
    expect(result).toContain("Plan failed: provider not configured")
    expect(result).toContain("[Plan]")
  })

  test("apply_failed shows error with both log links", () => {
    const ws = new Map<string, WorkspaceState>()
    ws.set("infra", {
      phase: "apply_failed",
      planSummary: "+1, ~0, -0",
      errorMessage: "quota exceeded",
      planCheckRun: planCheck,
      applyCheckRun: applyCheck,
    })

    const result = renderComment(SHA, ws)
    expect(result).toContain("Apply failed: quota exceeded")
    expect(result).toContain("[Plan]")
    expect(result).toContain("[Apply]")
  })

  test("destroying and destroyed phases", () => {
    const ws = new Map<string, WorkspaceState>()
    ws.set("infra", { phase: "destroying" })

    let result = renderComment(SHA, ws)
    expect(result).toContain("Destroying...")

    ws.set("infra", { phase: "destroyed" })
    result = renderComment(SHA, ws)
    expect(result).toContain("Destroyed")
  })

  test("plan_success shows plan summary (auto_apply: false)", () => {
    const ws = new Map<string, WorkspaceState>()
    ws.set("infra", {
      phase: "plan_success",
      planSummary: "+3, ~1, -0",
      planCheckRun: planCheck,
    })

    const result = renderComment(SHA, ws)
    expect(result).toContain("Plan: +3, ~1, -0")
    expect(result).toContain("[Plan]")
  })

  test("applying shows plan summary", () => {
    const ws = new Map<string, WorkspaceState>()
    ws.set("infra", {
      phase: "applying",
      planSummary: "+2, ~0, -1",
      planCheckRun: planCheck,
    })

    const result = renderComment(SHA, ws)
    expect(result).toContain("Applying (+2, ~0, -1)")
    expect(result).toContain("[Plan]")
  })

  test("no outputs section when workspace has empty outputs", () => {
    const ws = new Map<string, WorkspaceState>()
    ws.set("infra", {
      phase: "ready",
      outputs: {},
    })

    const result = renderComment(SHA, ws)
    expect(result).toContain("Preview ready")
    expect(result).not.toContain("<details>")
  })

  test("no outputs section when outputs is undefined", () => {
    const ws = new Map<string, WorkspaceState>()
    ws.set("infra", { phase: "ready" })

    const result = renderComment(SHA, ws)
    expect(result).not.toContain("<details>")
  })

  test("formats complex values", () => {
    const ws = new Map<string, WorkspaceState>()
    ws.set("infra", {
      phase: "ready",
      outputs: {
        tags: { value: { env: "dev", project: "yaffle" }, type: "object" },
      },
    })

    const result = renderComment(SHA, ws)
    expect(result).toContain('`{"env":"dev","project":"yaffle"}`')
  })
})

// ---------------------------------------------------------------------------
// PrCommentManager
// ---------------------------------------------------------------------------

describe("PrCommentManager", () => {
  test("calls writer with rendered comment on each update", async () => {
    const writes: string[] = []
    const manager = new PrCommentManager(CTX, {
      writer: async (_ctx, body, _marker) => { writes.push(body) },
    })

    await manager.update("infra", { phase: "planning" })
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain("Planning...")

    await manager.update("infra", { phase: "ready", outputs: { id: { value: "test" } } })
    expect(writes).toHaveLength(2)
    expect(writes[1]).toContain("Preview ready")
  })

  test("accumulates workspace states across updates", async () => {
    const writes: string[] = []
    const manager = new PrCommentManager(CTX, {
      writer: async (_ctx, body, _marker) => { writes.push(body) },
    })

    await manager.update("infra", { phase: "ready" })
    await manager.update("infra/monitoring", { phase: "planning" })

    // Second write should contain both workspaces
    expect(writes).toHaveLength(2)
    expect(writes[1]).toContain("infra")
    expect(writes[1]).toContain("infra/monitoring")
    expect(writes[1]).toContain("Preview ready")
    expect(writes[1]).toContain("Planning...")
  })

  test("serializes concurrent updates", async () => {
    const order: number[] = []
    let call = 0
    const manager = new PrCommentManager(CTX, {
      writer: async () => {
        const n = ++call
        await new Promise((r) => setTimeout(r, n === 1 ? 50 : 10))
        order.push(n)
      },
    })

    const p1 = manager.update("infra", { phase: "planning" })
    const p2 = manager.update("infra", { phase: "applying" })
    const p3 = manager.update("infra", { phase: "ready" })

    await Promise.all([p1, p2, p3])
    expect(order).toEqual([1, 2, 3])
  })

  test("writer failure does not block subsequent updates", async () => {
    let calls = 0
    const manager = new PrCommentManager(CTX, {
      writer: async () => {
        calls++
        if (calls === 1) throw new Error("API error")
      },
    })

    await manager.update("infra", { phase: "planning" })
    await manager.update("infra", { phase: "ready" })

    expect(calls).toBe(2)
  })

  test("getStates returns current workspace states", async () => {
    const manager = new PrCommentManager(CTX, {
      writer: async () => {},
    })

    await manager.update("infra", { phase: "planning" })
    await manager.update("infra/monitoring", { phase: "applying" })

    const states = manager.getStates()
    expect(states.get("infra")?.phase).toBe("planning")
    expect(states.get("infra/monitoring")?.phase).toBe("applying")
  })

  test("flush waits for pending writes", async () => {
    const results: string[] = []
    const manager = new PrCommentManager(CTX, {
      writer: async () => {
        await new Promise((r) => setTimeout(r, 30))
        results.push("done")
      },
    })

    manager.update("infra", { phase: "planning" })
    manager.update("infra", { phase: "ready" })

    await manager.flush()
    expect(results).toEqual(["done", "done"])
  })
})

// ---------------------------------------------------------------------------
// NoopCommentManager
// ---------------------------------------------------------------------------

describe("NoopCommentManager", () => {
  test("update and flush are no-ops", async () => {
    const noop = new NoopCommentManager()
    await noop.update("infra", { phase: "planning" })
    await noop.flush()
    // No error, no side effects
  })
})

// ---------------------------------------------------------------------------
// createCommentManager
// ---------------------------------------------------------------------------

describe("createCommentManager", () => {
  test("returns PrCommentManager for PR context with installation", () => {
    const manager = createCommentManager({
      kind: "pull_request",
      installationId: 123,
      owner: "o",
      repo: "r",
      headSha: "abc",
      prNumber: 1,
    })
    expect(manager).toBeInstanceOf(PrCommentManager)
  })

  test("returns NoopCommentManager for push context", () => {
    const manager = createCommentManager({
      kind: "push",
      installationId: 123,
      owner: "o",
      repo: "r",
      headSha: "abc",
    })
    expect(manager).toBeInstanceOf(NoopCommentManager)
  })

  test("returns NoopCommentManager when no installationId", () => {
    const manager = createCommentManager({
      kind: "pull_request",
      installationId: 0,
      owner: "o",
      repo: "r",
      headSha: "abc",
      prNumber: 1,
    })
    expect(manager).toBeInstanceOf(NoopCommentManager)
  })
})
