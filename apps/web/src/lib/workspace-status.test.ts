import { describe, expect, test } from "bun:test"

import type { DependencyGraph, WorkspaceWithRuns } from "$lib/api"

import {
  getBlockingUpstreamWorkspacePaths,
  getWorkspaceDisplayRuns,
  getWorkspaceConnectionBlockReason,
  getWorkspaceDisplayStatus,
  isWorkspaceActivelyRunningStatus,
  isWorkspaceInProgressStatus,
  normalizeWorkspaceStatus,
} from "./workspace-status"

function createWorkspace(
  workspacePath: string,
  previewStatus: string,
  runs: WorkspaceWithRuns["runs"] = [],
): WorkspaceWithRuns {
  return {
    preview: {
      id: `${workspacePath}-id`,
      workspacePath,
      status: previewStatus,
      connectionStatus: "not_required",
      missingProviders: [],
      conflictProviders: [],
      matchedConnections: [],
      blockedReason: null,
      stateKey: "",
      mode: "terraform",
      requireApproval: false,
      createdAt: new Date().toISOString(),
    },
    runs,
    outputs: null,
  }
}

function createRun(
  runType: string,
  status: string,
  createdAt = new Date().toISOString(),
): WorkspaceWithRuns["runs"][number] {
  return {
    id: `${runType}-${status}-${createdAt}`,
    previewId: "workspace-id",
    runGroupId: "rg-1",
    runType,
    status,
    checkRunId: null,
    planSummary: null,
    outputs: null,
    errorMessage: null,
    logOutput: null,
    startedAt: null,
    completedAt: null,
    createdAt,
  }
}

describe("workspace-status", () => {
  test("uses live preview status for latest workspaces without runs", () => {
    const workspace = createWorkspace("infra", "pending")

    expect(getWorkspaceDisplayStatus({
      workspace,
      workspaces: [workspace],
      dependencyGraph: null,
      isViewingLatest: true,
    })).toBe("pending")
  })

  test("normalizes awaiting_apply to planned", () => {
    const workspace = createWorkspace("infra", "awaiting_apply")

    expect(normalizeWorkspaceStatus("awaiting_apply")).toBe("planned")
    expect(getWorkspaceDisplayStatus({
      workspace,
      workspaces: [workspace],
      dependencyGraph: null,
      isViewingLatest: true,
    })).toBe("planned")
  })

  test("treats historical no-run workspaces with failed upstreams as skipped-success", () => {
    const graph: DependencyGraph = {
      workspaces: ["app", "infra"],
      edges: [["app", "infra"]],
    }
    const upstream = createWorkspace("infra", "failed", [createRun("plan", "failed")])
    const downstream = createWorkspace("app", "pending")

    expect(getWorkspaceDisplayStatus({
      workspace: downstream,
      workspaces: [downstream, upstream],
      dependencyGraph: graph,
      isViewingLatest: false,
    })).toBe("ready")
  })

  test("prefers apply and plan run states over preview placeholders", () => {
    const workspace = createWorkspace("infra", "pending", [createRun("apply", "running")])

    expect(getWorkspaceDisplayStatus({
      workspace,
      workspaces: [workspace],
      dependencyGraph: null,
      isViewingLatest: true,
    })).toBe("applying")
  })

  test("hides stale failed runs when a rerun is queued for the latest view", () => {
    const workspace = createWorkspace("infra", "pending", [
      createRun("apply", "failed", "2024-01-01T01:00:00.000Z"),
      createRun("plan", "success", "2024-01-01T00:00:00.000Z"),
    ])

    const displayRuns = getWorkspaceDisplayRuns({
      workspace,
      isViewingLatest: true,
    })

    expect(displayRuns).toEqual([])
    expect(getWorkspaceDisplayStatus({
      workspace: { ...workspace, runs: displayRuns },
      workspaces: [{ ...workspace, runs: displayRuns }],
      dependencyGraph: null,
      isViewingLatest: true,
    })).toBe("pending")
  })

  test("filters stale apply runs after a newer plan starts", () => {
    const workspace = createWorkspace("infra", "planning", [
      createRun("plan", "running", "2024-01-02T00:00:00.000Z"),
      createRun("apply", "failed", "2024-01-01T01:00:00.000Z"),
      createRun("plan", "success", "2024-01-01T00:00:00.000Z"),
    ])

    expect(getWorkspaceDisplayRuns({
      workspace,
      isViewingLatest: true,
    })).toEqual([
      expect.objectContaining({ runType: "plan", status: "running" }),
    ])
  })

  test("builds a connection block reason from connection readiness", () => {
    const workspace = createWorkspace("infra", "pending")
    workspace.preview.connectionStatus = "missing"
    workspace.preview.missingProviders = ["aws"]

    expect(getWorkspaceConnectionBlockReason(workspace)).toBe("Missing connections: aws")
  })

  test("ignores stale blocked reasons once readiness is restored", () => {
    const workspace = createWorkspace("infra", "pending")
    workspace.preview.connectionStatus = "ready"
    workspace.preview.blockedReason = "Missing connections: aws"

    expect(getWorkspaceConnectionBlockReason(workspace)).toBeNull()
  })

  test("detects upstream workspaces blocked by missing connections", () => {
    const graph: DependencyGraph = {
      workspaces: ["app", "infra"],
      edges: [["app", "infra"]],
    }
    const upstream = createWorkspace("infra", "pending")
    upstream.preview.connectionStatus = "missing"
    upstream.preview.missingProviders = ["aws"]
    const downstream = createWorkspace("app", "pending")

    expect(getBlockingUpstreamWorkspacePaths("app", [downstream, upstream], graph)).toEqual(["infra"])
  })

  test("classifies active and in-progress statuses consistently", () => {
    expect(isWorkspaceActivelyRunningStatus("planning")).toBe(true)
    expect(isWorkspaceActivelyRunningStatus("pending")).toBe(false)
    expect(isWorkspaceInProgressStatus("awaiting_approval")).toBe(true)
    expect(isWorkspaceInProgressStatus("ready")).toBe(false)
  })
})
