import { describe, expect, test } from "bun:test"

import { ensureRouteableDeployment } from "./ensure-routeable-deployment.ts"

describe("ensureRouteableDeployment", () => {
  test("creates an accepted operation and enqueues deployment reconciliation", async () => {
    const operations: Array<Record<string, unknown>> = []

    const result = await ensureRouteableDeployment({
      command: "ensure_routeable_deployment",
      requestId: "req-1",
      deploymentId: "dep-123",
      prNumber: 42,
      environmentName: "pr-42",
      environmentKind: "transient",
      ownerGithubUserId: 12345,
      ownerGithubLogin: "octocat",
      receiverUrl: "https://api-pr-42.preview.yaffle.dev/api/webhooks/github",
      receiverKind: "github_webhook",
      desiredState: "active",
    }, {
      findExistingOperation: async () => undefined,
      createOperation: async (input) => {
        const operation = {
          id: "op-1",
          requestId: input.requestId,
          operationType: input.operationType,
          status: input.status ?? "accepted",
          routeableDeploymentId: null,
          liveWebhookLeaseId: null,
          actorGithubUserId: input.actorGithubUserId ?? null,
          actorGithubLoginSnapshot: input.actorGithubLoginSnapshot ?? null,
          input: input.input,
          output: null,
          resultCode: null,
          resultMessage: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          completedAt: null,
        }
        operations.push(operation)
        return operation as never
      },
      findRouteableDeploymentByExternalId: async () => undefined,
      createAuditEvent: async () => ({ id: "audit-1" } as never),
      queue: {
        send: async (message) => {
          expect(message).toEqual({
            command: "reconcile_routeable_deployment",
            operationId: "op-1",
            routeableDeploymentId: "dep-123",
          })
        },
      },
    })

    expect(result).toEqual({
      status: "accepted",
      operationId: "op-1",
      resourceId: undefined,
    })
    expect(operations).toHaveLength(1)
  })

  test("returns existing operation for duplicate request ids", async () => {
    const existing = {
      id: "op-existing",
      requestId: "req-1",
      operationType: "ensure_routeable_deployment",
      status: "accepted",
      routeableDeploymentId: "rd-existing",
      liveWebhookLeaseId: null,
      actorGithubUserId: 12345,
      actorGithubLoginSnapshot: "octocat",
      input: {},
      output: null,
      resultCode: null,
      resultMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
    }

    const result = await ensureRouteableDeployment({
      command: "ensure_routeable_deployment",
      requestId: "req-1",
      deploymentId: "dep-123",
      prNumber: 42,
      environmentName: "pr-42",
      environmentKind: "transient",
      ownerGithubUserId: 12345,
      ownerGithubLogin: "octocat",
      receiverUrl: "https://api-pr-42.preview.yaffle.dev/api/webhooks/github",
      receiverKind: "github_webhook",
      desiredState: "active",
    }, {
      findExistingOperation: async () => existing as never,
      createOperation: async () => {
        throw new Error("createOperation should not be called")
      },
      findRouteableDeploymentByExternalId: async () => undefined,
      createAuditEvent: async () => ({ id: "audit-1" } as never),
      queue: {
        send: async () => {
          throw new Error("queue.send should not be called")
        },
      },
    })

    expect(result).toEqual({
      status: "operation",
      operation: {
        operationId: "op-existing",
        operationType: "ensure_routeable_deployment",
        status: "accepted",
        resultCode: undefined,
        resultMessage: undefined,
        leaseId: undefined,
        routeableDeploymentId: "rd-existing",
      },
    })
  })

  test("returns the known deployment id when one already exists", async () => {
    const result = await ensureRouteableDeployment({
      command: "ensure_routeable_deployment",
      requestId: "req-known",
      deploymentId: "dep-123",
      prNumber: 42,
      environmentName: "pr-42",
      environmentKind: "transient",
      ownerGithubUserId: 12345,
      ownerGithubLogin: "octocat",
      receiverUrl: "https://api-pr-42.preview.yaffle.dev/api/webhooks/github",
      receiverKind: "github_webhook",
      desiredState: "active",
    }, {
      findExistingOperation: async () => undefined,
      createOperation: async (input) => ({
        id: "op-known",
        requestId: input.requestId,
        operationType: input.operationType,
        status: input.status ?? "accepted",
        routeableDeploymentId: null,
        liveWebhookLeaseId: null,
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
      findRouteableDeploymentByExternalId: async () => ({
        id: "rd-existing",
        externalDeploymentId: "dep-123",
        prNumber: 42,
        environmentName: "pr-42",
        environmentKind: "transient",
        ownerGithubUserId: 12345,
        ownerGithubLoginSnapshot: "octocat",
        receiverUrl: "https://api-pr-42.preview.yaffle.dev/api/webhooks/github",
        receiverKind: "github_webhook",
        state: "active",
        lastSeenAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never),
      createAuditEvent: async () => ({ id: "audit-1" } as never),
      queue: {
        send: async (message) => {
          expect(message).toEqual({
            command: "reconcile_routeable_deployment",
            operationId: "op-known",
            routeableDeploymentId: "rd-existing",
          })
        },
      },
    })

    expect(result).toEqual({
      status: "accepted",
      operationId: "op-known",
      resourceId: "rd-existing",
    })
  })

  test("returns rejected if queueing fails", async () => {
    const result = await ensureRouteableDeployment({
      command: "ensure_routeable_deployment",
      requestId: "req-fail",
      deploymentId: "dep-123",
      prNumber: 42,
      environmentName: "pr-42",
      environmentKind: "transient",
      ownerGithubUserId: 12345,
      ownerGithubLogin: "octocat",
      receiverUrl: "https://api-pr-42.preview.yaffle.dev/api/webhooks/github",
      receiverKind: "github_webhook",
      desiredState: "active",
    }, {
      findExistingOperation: async () => undefined,
      createOperation: async (input) => ({
        id: "op-fail",
        requestId: input.requestId,
        operationType: input.operationType,
        status: input.status ?? "accepted",
        routeableDeploymentId: null,
        liveWebhookLeaseId: null,
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
      findRouteableDeploymentByExternalId: async () => undefined,
      createAuditEvent: async () => ({ id: "audit-1" } as never),
      queue: {
        send: async () => {
          throw new Error("queue unavailable")
        },
      },
    })

    expect(result).toEqual({
      status: "rejected",
      code: "QUEUE_ERROR",
      message: "queue unavailable",
    })
  })
})
