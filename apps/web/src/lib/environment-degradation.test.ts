import { describe, expect, test } from "bun:test"

import type { EnvironmentGroup } from "$lib/api"

import {
  countDegradedEnvironments,
  getWorkspaceDegradationMessage,
  summarizeEnvironmentDegradation,
} from "./environment-degradation"

function createEnvironment(overrides: Partial<EnvironmentGroup> = {}): EnvironmentGroup {
  return {
    repo: overrides.repo ?? "demo",
    ref: overrides.ref ?? "refs/heads/main",
    environmentName: overrides.environmentName ?? "production",
    headSha: overrides.headSha ?? "abc123",
    status: overrides.status ?? "ready",
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    workspaces: overrides.workspaces ?? [],
  }
}

describe("environment-degradation", () => {
  test("returns null when a workspace has no degradation", () => {
    expect(getWorkspaceDegradationMessage({ degradation: null })).toBeNull()
  })

  test("summarizes degraded workspaces by shared message", () => {
    const summary = summarizeEnvironmentDegradation(createEnvironment({
      workspaces: [
        {
          previewId: "a",
          workspacePath: "infra/core",
          status: "failed",
          connectionStatus: "not_required",
          missingProviders: [],
          conflictProviders: [],
          matchedConnections: [],
          blockedReason: null,
          degradation: {
            kind: "provider_requirements_unavailable",
            errorKind: "workspace_cache_missing",
            message: "Cached workspace archive is missing. Rerun this environment to regenerate provider metadata.",
            retryable: false,
          },
          headSha: "sha",
          lastRunId: null,
          lastRunType: null,
          lastRunStatus: null,
          lastRunCompletedAt: null,
          planSummary: null,
        },
        {
          previewId: "b",
          workspacePath: "infra/shared",
          status: "ready",
          connectionStatus: "not_required",
          missingProviders: [],
          conflictProviders: [],
          matchedConnections: [],
          blockedReason: null,
          degradation: {
            kind: "provider_requirements_unavailable",
            errorKind: "workspace_cache_missing",
            message: "Cached workspace archive is missing. Rerun this environment to regenerate provider metadata.",
            retryable: false,
          },
          headSha: "sha",
          lastRunId: null,
          lastRunType: null,
          lastRunStatus: null,
          lastRunCompletedAt: null,
          planSummary: null,
        },
      ],
    }))

    expect(summary).toEqual({
      totalWorkspaces: 2,
      groups: [
        {
          errorKind: "workspace_cache_missing",
          message: "Cached workspace archive is missing. Rerun this environment to regenerate provider metadata.",
          retryable: false,
          workspaces: ["infra/core", "infra/shared"],
        },
      ],
    })
  })

  test("counts degraded environments", () => {
    const degradedEnv = createEnvironment({
      environmentName: "production",
      workspaces: [
        {
          previewId: "a",
          workspacePath: "infra/core",
          status: "ready",
          connectionStatus: "not_required",
          missingProviders: [],
          conflictProviders: [],
          matchedConnections: [],
          blockedReason: null,
          degradation: {
            kind: "provider_requirements_unavailable",
            errorKind: "unknown",
            message: "Yaffle could not inspect this workspace to determine required providers.",
            retryable: true,
          },
          headSha: "sha",
          lastRunId: null,
          lastRunType: null,
          lastRunStatus: null,
          lastRunCompletedAt: null,
          planSummary: null,
        },
      ],
    })

    const healthyEnv = createEnvironment({ environmentName: "staging" })

    expect(countDegradedEnvironments([degradedEnv, healthyEnv])).toBe(1)
  })
})
