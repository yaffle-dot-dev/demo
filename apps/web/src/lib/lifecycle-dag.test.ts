import { describe, expect, test } from "@yaffle/test"

import type { DependencyGraph, EnvironmentLifecycleSummary, WorkspaceWithRuns } from "$lib/api"

import { buildPreviewDag } from "$lib/lifecycle-dag"

function workspace(workspacePath: string): WorkspaceWithRuns {
  return {
    preview: {
      id: workspacePath,
      workspacePath,
      status: "ready",
      connectionStatus: "not_required",
      missingProviders: [],
      conflictProviders: [],
      matchedConnections: [],
      blockedReason: null,
      stateKey: "",
      mode: "preview",
      requireApproval: false,
      createdAt: "2026-05-04T00:00:00Z",
    },
    runs: [],
    outputs: null,
  }
}

describe("buildPreviewDag", () => {
  test("attaches activation and verification items to workspace nodes", () => {
    const dependencyGraph: DependencyGraph = {
      workspaces: ["infra/shared", "apps/web/infra"],
      edges: [["apps/web/infra", "infra/shared"]],
    }
    const lifecycle: EnvironmentLifecycleSummary = {
      run: {
        id: "run-1",
        status: "succeeded",
        executionMode: "local",
        startedAt: "2026-05-04T00:00:00Z",
        finishedAt: "2026-05-04T00:00:05Z",
      },
      items: [
        {
          id: "item-1",
          runId: "run-1",
          workspacePath: "infra/shared",
          key: "preview-ready",
          phase: "activation",
          state: "succeeded",
          failurePolicy: "failed",
          scopes: ["usable", "acceptable"],
          summary: "ready",
          reason: null,
          metadata: {},
          startedAt: null,
          finishedAt: null,
          events: [],
        },
        {
          id: "item-2",
          runId: "run-1",
          workspacePath: "infra/shared",
          key: "preview-smoke",
          phase: "verification",
          state: "succeeded",
          failurePolicy: "failed",
          scopes: ["acceptable"],
          summary: "smoke passed",
          reason: null,
          metadata: {},
          startedAt: null,
          finishedAt: null,
          events: [],
        },
      ],
    }

    const result = buildPreviewDag({
      workspaces: [workspace("infra/shared"), workspace("apps/web/infra")],
      dependencyGraph,
      lifecycle,
    })

    expect(result.nodes.map((node) => node.id)).toEqual(["infra/shared", "apps/web/infra"])
    expect(result.dependencyGraph?.edges).toEqual([["apps/web/infra", "infra/shared"]])
    expect(result.nodes[0]?.kind).toBe("workspace")
    if (result.nodes[0]?.kind !== "workspace") return
    expect(result.nodes[0].lifecycleItems.map((item) => `${item.phase}:${item.key}`)).toEqual([
      "activation:preview-ready",
      "verification:preview-smoke",
    ])
  })
})
