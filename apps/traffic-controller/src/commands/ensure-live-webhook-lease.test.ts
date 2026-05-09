import { describe, expect, test } from "@yaffle/test"

import { ensureLiveWebhookLease } from "./ensure-live-webhook-lease.ts"

const activeDeployment = {
  id: "rd-1",
  externalDeploymentId: "dep-123",
  prNumber: 42,
  environmentName: "pr-42",
  environmentKind: "transient",
  ownerGithubUserId: 12345,
  ownerGithubLoginSnapshot: "octocat",
  receiverUrl: "https://api-pr-42.preview.yaffle.dev/api/webhooks/github",
  receiverKind: "github_webhook",
  hookdeckDestinationId: "dest-1",
  hookdeckDestinationName: "dest-name",
  lastReconciledAt: new Date(),
  lastSyncError: null,
  state: "active",
  lastSeenAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
} as const

const githubPolicy = {
  assertMonorepoWriteAccess: async () => undefined,
  assertPullRequestOpen: async () => undefined,
  assertPersonalScopeOwnership: async () => ({
    githubOwnerType: "user",
    githubOwnerId: 12345,
    githubOwnerLogin: "octocat",
  }),
}

describe("ensureLiveWebhookLease", () => {
  test("creates an accepted ensure operation and queues lease reconciliation", async () => {
    const result = await ensureLiveWebhookLease({
      command: "ensure_live_webhook_lease",
      requestId: "req-lease-1",
      actorGithubUserId: 12345,
      actorGithubLogin: "octocat",
      prNumber: 42,
      deploymentId: "dep-123",
      desiredState: "active",
      scope: {
        event: "pull_request",
        installationId: 777,
        repositoryId: 888,
        action: "opened",
      },
      reason: "repo connection test",
    }, {
      findExistingOperation: async () => undefined,
      createOperation: async (input) => ({
        id: "op-lease-1",
        requestId: input.requestId,
        operationType: input.operationType,
        status: input.status ?? "accepted",
        routeableDeploymentId: input.routeableDeploymentId ?? null,
        liveWebhookLeaseId: input.liveWebhookLeaseId ?? null,
        actorGithubUserId: input.actorGithubUserId ?? null,
        actorGithubLoginSnapshot: input.actorGithubLoginSnapshot ?? null,
        input: input.input,
        output: null,
        resultCode: null,
        resultMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: null,
      } as never),
      markOperationSucceeded: async () => undefined,
      findRouteableDeploymentByExternalId: async () => activeDeployment as never,
      findExactLease: async () => undefined,
      findOverlappingLeases: async () => [],
      createAuditEvent: async () => ({ id: "audit-1" } as never),
      createLiveWebhookLease: async () => ({
        id: "lease-1",
        status: "requested",
        prNumber: 42,
        routeableDeploymentId: "rd-1",
        actorGithubUserId: 12345,
        actorGithubLoginSnapshot: "octocat",
        scopeClass: "repo",
        event: "pull_request",
        installationId: 777,
        repositoryId: 888,
        action: "opened",
        pullRequestNumber: null,
        ref: null,
        githubOwnerTypeSnapshot: "user",
        githubOwnerIdSnapshot: 12345,
        githubOwnerLoginSnapshot: "octocat",
        reason: "repo connection test",
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
      } as never),
      markLiveWebhookLeaseRevoking: async () => undefined,
      githubPolicy,
      queue: {
        send: async (message) => {
          expect(message).toEqual({
            command: "reconcile_live_webhook_lease",
            operationId: "op-lease-1",
            leaseId: "lease-1",
          })
        },
      },
    })

    expect(result).toEqual({
      status: "accepted",
      operationId: "op-lease-1",
      resourceId: "lease-1",
    })
  })

  test("rejects overlapping lease conflicts", async () => {
    const result = await ensureLiveWebhookLease({
      command: "ensure_live_webhook_lease",
      requestId: "req-lease-conflict",
      actorGithubUserId: 12345,
      actorGithubLogin: "octocat",
      prNumber: 42,
      deploymentId: "dep-123",
      desiredState: "active",
      scope: {
        event: "pull_request",
        installationId: 777,
        repositoryId: 888,
        action: "opened",
      },
      reason: "repo connection test",
    }, {
      findExistingOperation: async () => undefined,
      createOperation: async () => {
        throw new Error("createOperation should not be called")
      },
      markOperationSucceeded: async () => undefined,
      findRouteableDeploymentByExternalId: async () => activeDeployment as never,
      findExactLease: async () => undefined,
      findOverlappingLeases: async () => ([{
        id: "lease-conflict",
        status: "active",
        prNumber: 9001,
        routeableDeploymentId: "rd-other",
        actorGithubUserId: 67890,
        actorGithubLoginSnapshot: "other-user",
        scopeClass: "repo",
        event: "pull_request",
        installationId: 777,
        repositoryId: 888,
        action: null,
        pullRequestNumber: null,
        ref: null,
        githubOwnerTypeSnapshot: "user",
        githubOwnerIdSnapshot: 67890,
        githubOwnerLoginSnapshot: "other-user",
        reason: "busy",
        hookdeckDestinationId: null,
        hookdeckDestinationName: null,
        hookdeckConnectionId: null,
        hookdeckConnectionName: null,
        lastReconciledAt: null,
        lastSyncError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        activatedAt: new Date(),
        revokedAt: null,
      }] as never),
      createAuditEvent: async () => ({ id: "audit-1" } as never),
      createLiveWebhookLease: async () => {
        throw new Error("createLiveWebhookLease should not be called")
      },
      markLiveWebhookLeaseRevoking: async () => undefined,
      githubPolicy,
      queue: {
        send: async () => {
          throw new Error("queue.send should not be called")
        },
      },
    })

    expect(result).toEqual({
      status: "rejected",
      code: "LEASE_CONFLICT",
      message: "an overlapping live webhook lease already exists",
    })
  })

  test("rejects actors without monorepo write access", async () => {
    const result = await ensureLiveWebhookLease({
      command: "ensure_live_webhook_lease",
      requestId: "req-no-write",
      actorGithubUserId: 12345,
      actorGithubLogin: "octocat",
      prNumber: 42,
      deploymentId: "dep-123",
      desiredState: "active",
      scope: {
        event: "installation_repositories",
        installationId: 777,
      },
      reason: "repo connection test",
    }, {
      findExistingOperation: async () => undefined,
      createOperation: async () => {
        throw new Error("createOperation should not be called")
      },
      markOperationSucceeded: async () => undefined,
      findRouteableDeploymentByExternalId: async () => activeDeployment as never,
      findExactLease: async () => undefined,
      findOverlappingLeases: async () => [],
      createAuditEvent: async () => ({ id: "audit-1" } as never),
      createLiveWebhookLease: async () => {
        throw new Error("createLiveWebhookLease should not be called")
      },
      markLiveWebhookLeaseRevoking: async () => undefined,
      githubPolicy: {
        assertMonorepoWriteAccess: async () => {
          throw new Error("YAFFLE_MONOREPO_WRITE_REQUIRED")
        },
        assertPullRequestOpen: async () => undefined,
        assertPersonalScopeOwnership: async () => ({
          githubOwnerType: "user",
          githubOwnerId: 12345,
          githubOwnerLogin: "octocat",
        }),
      },
      queue: {
        send: async () => {
          throw new Error("queue.send should not be called")
        },
      },
    })

    expect(result).toEqual({
      status: "rejected",
      code: "YAFFLE_MONOREPO_WRITE_REQUIRED",
      message: "YAFFLE_MONOREPO_WRITE_REQUIRED",
    })
  })
})
