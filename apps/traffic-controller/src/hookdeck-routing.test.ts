import { describe, expect, test } from "@yaffle/test"

import {
  buildHookdeckDestinationName,
  buildHookdeckPreviewConnectionName,
  buildHookdeckPreviewConnectionRules,
  buildHookdeckProductionConnections,
  HOOKDECK_LIVE_LEASE_EVENT_ALLOWLIST,
} from "./hookdeck-routing.ts"

describe("hookdeck routing compiler", () => {
  test("builds deterministic routeable deployment destination names", () => {
    expect(buildHookdeckDestinationName("dep-manual-1")).toBe("yaffle-routeable-deployment-dep-manual-1")
  })

  test("builds exact preview connection filters", () => {
    const rules = buildHookdeckPreviewConnectionRules({
      event: "pull_request",
      installationId: 123,
      repositoryId: 456,
      action: "opened",
      pullRequestNumber: 42,
      ref: null,
    })

    expect(rules).toEqual([{
      type: "filter",
      headers: {
        "x-github-event": "pull_request",
      },
      body: {
        installation: { id: 123 },
        repository: { id: 456 },
        action: "opened",
        pull_request: { number: 42 },
      },
    }])
  })

  test("builds production connections for managed events and catch-all traffic", () => {
    const connections = buildHookdeckProductionConnections({
      baseConnectionName: "github-app-to-control-plane-main",
      sourceId: "src_123",
      destinationId: "dest_prod",
      activeLeases: [{
        id: "lease-1",
        status: "active",
        prNumber: 42,
        routeableDeploymentId: "rd-1",
        actorGithubUserId: 12345,
        actorGithubLoginSnapshot: "octocat",
        scopeClass: "repo",
        event: "pull_request",
        installationId: 123,
        repositoryId: 456,
        action: "opened",
        pullRequestNumber: 42,
        ref: null,
        githubOwnerTypeSnapshot: "user",
        githubOwnerIdSnapshot: 12345,
        githubOwnerLoginSnapshot: "octocat",
        reason: "test",
        hookdeckDestinationId: "dest_preview",
        hookdeckDestinationName: "preview-dest",
        hookdeckConnectionId: "conn_preview",
        hookdeckConnectionName: buildHookdeckPreviewConnectionName("lease-1"),
        lastReconciledAt: new Date(),
        lastSyncError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        activatedAt: new Date(),
        revokedAt: null,
        routeableDeployment: {
          id: "rd-1",
          externalDeploymentId: "dep-123",
          prNumber: 42,
          environmentName: "pr-42",
          environmentKind: "transient",
          ownerGithubUserId: 12345,
          ownerGithubLoginSnapshot: "octocat",
          receiverUrl: "https://api-pr-42.preview.yaffle.dev/api/webhooks/github",
          receiverKind: "github_webhook",
          hookdeckDestinationId: "dest_preview",
          hookdeckDestinationName: "preview-dest",
          lastReconciledAt: new Date(),
          lastSyncError: null,
          state: "active",
          lastSeenAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }],
    })

    expect(connections).toHaveLength(1 + HOOKDECK_LIVE_LEASE_EVENT_ALLOWLIST.length)
    expect(connections[0].rules).toEqual([{
      type: "filter",
      headers: {
        "x-github-event": {
          $nin: [...HOOKDECK_LIVE_LEASE_EVENT_ALLOWLIST],
        },
      },
    }])
  })
})
