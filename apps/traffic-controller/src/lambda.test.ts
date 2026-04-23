import { describe, expect, test } from "bun:test"

import { handleApiCommand, handler as apiHandler } from "./api-lambda.ts"
import { handler as reconcileHandler, handlerWithDeps as reconcileHandlerWithDeps } from "./reconcile-lambda.ts"

describe("traffic-controller lambda scaffolds", () => {
  test("accepts direct invoke payloads without an API Gateway body wrapper", async () => {
    const response = await apiHandler({
      command: "ensure_live_webhook_lease",
      requestId: "req-1",
      actorGithubUserId: 123,
      actorGithubLogin: "octocat",
      prNumber: 42,
      deploymentId: "dep-123",
      desiredState: "active",
      reason: "test",
      scope: {
        event: "installation_repositories",
        installationId: 999,
      },
    })

    expect(response.statusCode).toBe(501)
  })

  test("returns validation errors for invalid api payloads", async () => {
    const response = await apiHandler({
      body: JSON.stringify({ command: "ensure_live_webhook_lease" }),
    })

    expect(response.statusCode).toBe(400)
  })

  test("returns not implemented for unbuilt lease commands", async () => {
    const response = await apiHandler({
      body: JSON.stringify({
        command: "ensure_live_webhook_lease",
        requestId: "req-1",
        actorGithubUserId: 123,
        actorGithubLogin: "octocat",
        prNumber: 42,
        deploymentId: "dep-123",
        desiredState: "active",
        reason: "test",
        scope: {
          event: "installation_repositories",
          installationId: 999,
        },
      }),
    })

    expect(response.statusCode).toBe(501)
  })

  test("returns operation state for successful routeable deployment commands", async () => {
    const result = await handleApiCommand({
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
      ensureRouteableDeployment: async () => ({
        status: "operation",
        operation: {
          operationId: "op-1",
          operationType: "ensure_routeable_deployment",
          status: "succeeded",
          routeableDeploymentId: "rd-1",
        },
      }),
      findOperationById: async () => undefined,
    })

    expect(result).toEqual({
      status: "operation",
      operation: {
        operationId: "op-1",
        operationType: "ensure_routeable_deployment",
        status: "succeeded",
        routeableDeploymentId: "rd-1",
      },
    })
  })

  test("accepts API Gateway style wrapped command payloads", async () => {
    const response = await apiHandler({
      body: JSON.stringify({
        command: "ensure_live_webhook_lease",
        requestId: "req-2",
        actorGithubUserId: 123,
        actorGithubLogin: "octocat",
        prNumber: 42,
        deploymentId: "dep-123",
        desiredState: "active",
        reason: "test",
        scope: {
          event: "installation_repositories",
          installationId: 999,
        },
      }),
    })

    expect(response.statusCode).toBe(501)
  })

  test("returns operation state when querying an existing operation", async () => {
    const result = await handleApiCommand({
      command: "get_operation",
      operationId: "op-123",
    }, {
      ensureRouteableDeployment: async () => {
        throw new Error("ensureRouteableDeployment should not be called")
      },
      findOperationById: async () => ({
        id: "op-123",
        requestId: "req-123",
        operationType: "ensure_routeable_deployment",
        status: "succeeded",
        routeableDeploymentId: "rd-123",
        liveWebhookLeaseId: null,
        actorGithubUserId: null,
        actorGithubLoginSnapshot: null,
        input: {},
        output: null,
        resultCode: null,
        resultMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: new Date(),
      } as never),
    })

    expect(result).toEqual({
      status: "operation",
      operation: {
        operationId: "op-123",
        operationType: "ensure_routeable_deployment",
        status: "succeeded",
        resultCode: undefined,
        resultMessage: undefined,
        leaseId: undefined,
        routeableDeploymentId: "rd-123",
      },
    })
  })

  test("rejects invalid reconcile payloads", async () => {
    await expect(reconcileHandler({ command: "unknown" })).rejects.toThrow("Invalid reconcile payload")
  })

  test("keeps reconcile path explicitly unimplemented for now", async () => {
    await expect(reconcileHandler({
      command: "sweep_drift",
      requestId: "sweep-1",
    })).rejects.toThrow("sweep_drift is not implemented yet")
  })

  test("reconcile handler processes routeable deployment messages", async () => {
    const response = await reconcileHandlerWithDeps({
      command: "reconcile_routeable_deployment",
      operationId: "op-1",
      routeableDeploymentId: "dep-123",
    }, {
      findOperationById: async () => ({
        id: "op-1",
        requestId: "req-1",
        operationType: "ensure_routeable_deployment",
        status: "accepted",
        routeableDeploymentId: null,
        liveWebhookLeaseId: null,
        actorGithubUserId: 12345,
        actorGithubLoginSnapshot: "octocat",
        input: {
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
        },
        output: null,
        resultCode: null,
        resultMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: null,
      } as never),
      reconcileRouteableDeployment: async () => undefined,
    })

    expect(response).toEqual({ ok: true })
  })

  test("reconcile handler processes SQS-wrapped routeable deployment messages", async () => {
    let invoked = 0

    const response = await reconcileHandlerWithDeps({
      Records: [
        {
          body: JSON.stringify({
            command: "reconcile_routeable_deployment",
            operationId: "op-1",
            routeableDeploymentId: "dep-123",
          }),
        },
      ],
    }, {
      findOperationById: async () => ({
        id: "op-1",
        requestId: "req-1",
        operationType: "ensure_routeable_deployment",
        status: "accepted",
        routeableDeploymentId: null,
        liveWebhookLeaseId: null,
        actorGithubUserId: 12345,
        actorGithubLoginSnapshot: "octocat",
        input: {
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
        },
        output: null,
        resultCode: null,
        resultMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: null,
      } as never),
      reconcileRouteableDeployment: async () => {
        invoked += 1
      },
    })

    expect(invoked).toBe(1)
    expect(response).toEqual({ ok: true, processedCount: 1 })
  })
})
