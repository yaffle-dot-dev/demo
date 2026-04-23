import { describe, expect, test } from "bun:test"

import { reconcileRouteableDeployment } from "./reconcile-routeable-deployment.ts"

describe("reconcileRouteableDeployment", () => {
  test("marks operation succeeded after upserting the deployment", async () => {
    const calls: Array<{ kind: string; payload?: unknown }> = []

    await reconcileRouteableDeployment({
      operationId: "op-1",
      deploymentId: "dep-123",
      command: {
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
    }, {
      markOperationRunning: async (operationId) => {
        calls.push({ kind: "running", payload: operationId })
        return undefined
      },
      markOperationSucceeded: async (operationId, params) => {
        calls.push({ kind: "succeeded", payload: { operationId, params } })
        return undefined
      },
      markOperationFailed: async () => undefined,
      findRouteableDeploymentByExternalId: async () => undefined,
      upsertRouteableDeployment: async (input) => {
        calls.push({ kind: "upsert", payload: input })
        return {
          id: "rd-1",
          externalDeploymentId: input.externalDeploymentId,
          prNumber: input.prNumber,
          environmentName: input.environmentName,
          environmentKind: input.environmentKind,
          ownerGithubUserId: input.ownerGithubUserId,
          ownerGithubLoginSnapshot: input.ownerGithubLoginSnapshot,
          receiverUrl: input.receiverUrl,
          receiverKind: input.receiverKind,
          state: input.state,
          lastSeenAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        } as never
      },
    })

    expect(calls.map((call) => call.kind)).toEqual(["running", "upsert", "succeeded"])
  })

  test("marks operation failed when upsert throws", async () => {
    const failures: Array<{ resultCode: string; resultMessage: string }> = []

    await expect(reconcileRouteableDeployment({
      operationId: "op-1",
      deploymentId: "dep-123",
      command: {
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
    }, {
      markOperationRunning: async () => undefined,
      markOperationSucceeded: async () => undefined,
      markOperationFailed: async (_operationId, params) => {
        failures.push(params)
        return undefined
      },
      findRouteableDeploymentByExternalId: async () => undefined,
      upsertRouteableDeployment: async () => {
        throw new Error("db write failed")
      },
    })).rejects.toThrow("db write failed")

    expect(failures).toEqual([
      {
        resultCode: "RECONCILE_ROUTEABLE_DEPLOYMENT_FAILED",
        resultMessage: "db write failed",
      },
    ])
  })
})
