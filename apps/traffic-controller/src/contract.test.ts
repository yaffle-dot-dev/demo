import { describe, expect, test } from "@yaffle/test"

import {
  ensureLiveWebhookLeaseRequestSchema,
  ensureRouteableDeploymentRequestSchema,
  isFinalOperationStatus,
  trafficControllerApiCommandSchema,
  trafficControllerReconcileCommandSchema,
} from "./contract.ts"

describe("traffic-controller contract", () => {
  test("accepts routeable deployment commands from CI", () => {
    const parsed = ensureRouteableDeploymentRequestSchema.parse({
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
    })

    expect(parsed.deploymentId).toBe("dep-123")
  })

  test("requires repository id for pull_request and push leases", () => {
    const parsed = ensureLiveWebhookLeaseRequestSchema.safeParse({
      command: "ensure_live_webhook_lease",
      requestId: "req-2",
      actorGithubUserId: 12345,
      actorGithubLogin: "octocat",
      prNumber: 42,
      deploymentId: "dep-123",
      desiredState: "active",
      scope: {
        event: "pull_request",
        installationId: 999,
      },
      reason: "repo connection test",
    })

    expect(parsed.success).toBe(false)
  })

  test("rejects repository ids on installation_repositories leases", () => {
    const parsed = ensureLiveWebhookLeaseRequestSchema.safeParse({
      command: "ensure_live_webhook_lease",
      requestId: "req-3",
      actorGithubUserId: 12345,
      actorGithubLogin: "octocat",
      prNumber: 42,
      deploymentId: "dep-123",
      desiredState: "active",
      scope: {
        event: "installation_repositories",
        installationId: 999,
        repositoryId: 111,
      },
      reason: "repo connection test",
    })

    expect(parsed.success).toBe(false)
  })

  test("builds discriminated unions for api and reconcile commands", () => {
    expect(trafficControllerApiCommandSchema.parse({
      command: "get_operation",
      operationId: "op-123",
    }).command).toBe("get_operation")

    expect(trafficControllerReconcileCommandSchema.parse({
      command: "sweep_drift",
      requestId: "sweep-1",
    }).command).toBe("sweep_drift")
  })

  test("marks only succeeded, failed, and rejected as final", () => {
    expect(isFinalOperationStatus("accepted")).toBe(false)
    expect(isFinalOperationStatus("running")).toBe(false)
    expect(isFinalOperationStatus("succeeded")).toBe(true)
    expect(isFinalOperationStatus("failed")).toBe(true)
    expect(isFinalOperationStatus("rejected")).toBe(true)
  })
})
