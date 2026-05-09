import { describe, expect, test } from "@yaffle/test"

import { reconcileLiveWebhookLease } from "./reconcile-live-webhook-lease.ts"

const lease = {
  id: "lease-1",
  status: "requested",
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
  reason: "test lease",
  hookdeckDestinationId: null,
  hookdeckDestinationName: null,
  hookdeckConnectionId: null,
  hookdeckConnectionName: null,
  lastReconciledAt: null,
  lastSyncError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  activatedAt: null,
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
    hookdeckDestinationId: null,
    hookdeckDestinationName: null,
    lastReconciledAt: null,
    lastSyncError: null,
    state: "active",
    lastSeenAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  },
} as const

describe("reconcileLiveWebhookLease", () => {
  test("activates a lease after Hookdeck routing converges", async () => {
    const calls: string[] = []

    await reconcileLiveWebhookLease({
      operationId: "op-1",
      leaseId: "lease-1",
    }, {
      markOperationRunning: async () => undefined,
      markOperationSucceeded: async () => undefined,
      markOperationFailed: async () => undefined,
      findLease: async () => lease as never,
      listActiveLeases: async () => [],
      updateLease: async (_leaseId, params) => {
        calls.push(params.status ?? "updated")
        return undefined
      },
      updateRouteableDeploymentHookdeckMetadata: async () => undefined,
      getHookdeckRoutingConfig: async () => ({
        apiKey: "hookdeck-token",
        githubSourceId: "src_123",
        githubSourceName: "yaffle-github-app",
        productionDestinationId: "dest_prod",
        productionDestinationName: "yaffle-control-plane-main",
        productionConnectionName: "github-app-to-control-plane-main",
      }),
      createHookdeckRoutingClient: async () => ({
        upsertDestination: async () => ({ id: "dest_preview", name: "preview-dest" } as never),
        upsertConnection: async (request) => ({
          id: request.name === "yaffle-live-lease-lease-1" ? "conn_preview" : `conn_${request.name}`,
          name: request.name,
        } as never),
        deleteConnection: async () => undefined,
      }),
      createAuditEvent: async () => ({ id: "audit-1" } as never),
    })

    expect(calls).toContain("active")
  })

  test("revokes a lease by deleting the preview connection and restoring prod routing", async () => {
    const deleteCalls: string[] = []

    await reconcileLiveWebhookLease({
      operationId: "op-2",
      leaseId: "lease-2",
    }, {
      markOperationRunning: async () => undefined,
      markOperationSucceeded: async () => undefined,
      markOperationFailed: async () => undefined,
      findLease: async () => ({
        ...lease,
        id: "lease-2",
        status: "revoking",
        hookdeckConnectionId: "conn_preview",
      } as never),
      listActiveLeases: async () => [],
      updateLease: async () => undefined,
      updateRouteableDeploymentHookdeckMetadata: async () => undefined,
      getHookdeckRoutingConfig: async () => ({
        apiKey: "hookdeck-token",
        githubSourceId: "src_123",
        githubSourceName: "yaffle-github-app",
        productionDestinationId: "dest_prod",
        productionDestinationName: "yaffle-control-plane-main",
        productionConnectionName: "github-app-to-control-plane-main",
      }),
      createHookdeckRoutingClient: async () => ({
        upsertDestination: async () => ({ id: "dest_preview", name: "preview-dest" } as never),
        upsertConnection: async (request) => ({ id: `conn_${request.name}`, name: request.name } as never),
        deleteConnection: async (id) => {
          deleteCalls.push(id)
        },
      }),
      createAuditEvent: async () => ({ id: "audit-1" } as never),
    })

    expect(deleteCalls).toEqual(["conn_preview"])
  })
})
