import type {
  EnsureLiveWebhookLeaseRequest,
  TrafficControllerApiResponse,
} from "../contract.ts"
import {
  createTrafficControlOperation,
  findInFlightOperationByRequestIdAndType,
  markOperationSucceeded,
  type TrafficControlOperation,
} from "../db/queries/operations.ts"
import { createTrafficControlAuditEvent } from "../db/queries/audit-events.ts"
import {
  createLiveWebhookLease,
  findLiveWebhookLeaseByExactScope,
  findOverlappingLiveWebhookLeases,
  markLiveWebhookLeaseRevoking,
} from "../db/queries/live-webhook-leases.ts"
import { findRouteableDeploymentByExternalId } from "../db/queries/routeable-deployments.ts"
import { createGithubPolicyClient, type GithubPolicyClient } from "../github-app-client.ts"
import type { ReconcileQueueClient } from "../reconcile-queue.ts"

interface EnsureLiveWebhookLeaseDeps {
  findExistingOperation: typeof findInFlightOperationByRequestIdAndType
  createOperation: typeof createTrafficControlOperation
  markOperationSucceeded: typeof markOperationSucceeded
  findRouteableDeploymentByExternalId: typeof findRouteableDeploymentByExternalId
  findExactLease: typeof findLiveWebhookLeaseByExactScope
  findOverlappingLeases: typeof findOverlappingLiveWebhookLeases
  createLiveWebhookLease: typeof createLiveWebhookLease
  markLiveWebhookLeaseRevoking: typeof markLiveWebhookLeaseRevoking
  githubPolicy: GithubPolicyClient
  createAuditEvent: typeof createTrafficControlAuditEvent
  queue: ReconcileQueueClient
}

export function createEnsureLiveWebhookLeaseDeps(queue: ReconcileQueueClient): EnsureLiveWebhookLeaseDeps {
  return {
    findExistingOperation: findInFlightOperationByRequestIdAndType,
    createOperation: createTrafficControlOperation,
    markOperationSucceeded,
    findRouteableDeploymentByExternalId,
    findExactLease: findLiveWebhookLeaseByExactScope,
    findOverlappingLeases: findOverlappingLiveWebhookLeases,
    createLiveWebhookLease,
    markLiveWebhookLeaseRevoking,
    githubPolicy: createGithubPolicyClient(),
    createAuditEvent: createTrafficControlAuditEvent,
    queue,
  }
}

function operationToApiResponse(
  operation: TrafficControlOperation,
): Extract<TrafficControllerApiResponse, { status: "operation" }> {
  return {
    status: "operation",
    operation: {
      operationId: operation.id,
      operationType: operation.operationType,
      status: operation.status,
      resultCode: operation.resultCode ?? undefined,
      resultMessage: operation.resultMessage ?? undefined,
      leaseId: operation.liveWebhookLeaseId ?? undefined,
      routeableDeploymentId: operation.routeableDeploymentId ?? undefined,
    },
  }
}

export async function ensureLiveWebhookLease(
  command: EnsureLiveWebhookLeaseRequest,
  deps: EnsureLiveWebhookLeaseDeps,
): Promise<TrafficControllerApiResponse> {
  const operationType = command.desiredState === "active"
    ? "ensure_live_webhook_lease"
    : "revoke_live_webhook_lease"

  const existingOperation = await deps.findExistingOperation(command.requestId, operationType)
  if (existingOperation) {
    return operationToApiResponse(existingOperation)
  }

  const routeableDeployment = await deps.findRouteableDeploymentByExternalId(command.deploymentId)
  if (!routeableDeployment) {
    return {
      status: "rejected",
      code: "ROUTEABLE_DEPLOYMENT_NOT_FOUND",
      message: `routeable deployment '${command.deploymentId}' not found`,
    }
  }

  if (routeableDeployment.ownerGithubUserId !== command.actorGithubUserId) {
    return {
      status: "rejected",
      code: "DEPLOYMENT_OWNERSHIP_MISMATCH",
      message: "actor does not own the target routeable deployment",
    }
  }

  if (routeableDeployment.prNumber !== command.prNumber) {
    return {
      status: "rejected",
      code: "PR_MISMATCH",
      message: "requested PR does not match the routeable deployment PR",
    }
  }

  try {
    await deps.githubPolicy.assertMonorepoWriteAccess(command.actorGithubLogin)
    await deps.githubPolicy.assertPullRequestOpen(command.prNumber)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      status: "rejected",
      code: message,
      message,
    }
  }

  let ownerSnapshot: {
    githubOwnerType: string
    githubOwnerId: number
    githubOwnerLogin: string
  }

  try {
    ownerSnapshot = await deps.githubPolicy.assertPersonalScopeOwnership({
      actorGithubUserId: command.actorGithubUserId,
      actorGithubLogin: command.actorGithubLogin,
      installationId: command.scope.installationId,
      repositoryId: command.scope.repositoryId,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      status: "rejected",
      code: message,
      message,
    }
  }

  const exactLease = await deps.findExactLease({
    routeableDeploymentId: routeableDeployment.id,
    event: command.scope.event,
    installationId: command.scope.installationId,
    repositoryId: command.scope.repositoryId,
    action: command.scope.action,
    pullRequestNumber: command.scope.pullRequestNumber,
    ref: command.scope.ref,
    statuses: ["requested", "active", "revoking"],
  })

  if (command.desiredState === "absent") {
    if (!exactLease) {
      const operation = await deps.createOperation({
        requestId: command.requestId,
        operationType,
        input: command,
        actorGithubUserId: command.actorGithubUserId,
        actorGithubLoginSnapshot: command.actorGithubLogin,
        routeableDeploymentId: routeableDeployment.id,
        status: "accepted",
      })

      const succeeded = await deps.markOperationSucceeded(operation.id, {
        routeableDeploymentId: routeableDeployment.id,
        output: {
          desiredState: "absent",
          result: "already_absent",
        },
      })
      await deps.createAuditEvent({
        operationId: succeeded?.id ?? operation.id,
        routeableDeploymentId: routeableDeployment.id,
        eventType: "live_webhook_lease.already_absent",
        actorGithubUserId: command.actorGithubUserId,
        actorGithubLoginSnapshot: command.actorGithubLogin,
        details: {
          deploymentId: command.deploymentId,
          event: command.scope.event,
          installationId: command.scope.installationId,
        },
      })

      return operationToApiResponse(succeeded ?? operation)
    }

    if (exactLease.status !== "revoking") {
      await deps.markLiveWebhookLeaseRevoking(exactLease.id)
    }

    const operation = await deps.createOperation({
      requestId: command.requestId,
      operationType,
      input: command,
      actorGithubUserId: command.actorGithubUserId,
      actorGithubLoginSnapshot: command.actorGithubLogin,
      routeableDeploymentId: routeableDeployment.id,
      liveWebhookLeaseId: exactLease.id,
      status: "accepted",
    })

    await deps.queue.send({
      command: "reconcile_live_webhook_lease",
      operationId: operation.id,
      leaseId: exactLease.id,
    })
    await deps.createAuditEvent({
      operationId: operation.id,
      routeableDeploymentId: routeableDeployment.id,
      liveWebhookLeaseId: exactLease.id,
      eventType: "live_webhook_lease.revoke_requested",
      actorGithubUserId: command.actorGithubUserId,
      actorGithubLoginSnapshot: command.actorGithubLogin,
      details: {
        deploymentId: command.deploymentId,
        event: command.scope.event,
        installationId: command.scope.installationId,
      },
    })

    return {
      status: "accepted",
      operationId: operation.id,
      resourceId: exactLease.id,
    }
  }

  if (routeableDeployment.state !== "active") {
    return {
      status: "rejected",
      code: "ROUTEABLE_DEPLOYMENT_NOT_ACTIVE",
      message: "routeable deployment must be active before creating a live lease",
    }
  }

  const overlapping = await deps.findOverlappingLeases({
    event: command.scope.event,
    installationId: command.scope.installationId,
    repositoryId: command.scope.repositoryId,
    action: command.scope.action,
    pullRequestNumber: command.scope.pullRequestNumber,
    ref: command.scope.ref,
    excludeLeaseId: exactLease?.id,
    statuses: ["requested", "active", "revoking"],
  })

  if (overlapping.length > 0) {
    return {
      status: "rejected",
      code: "LEASE_CONFLICT",
      message: "an overlapping live webhook lease already exists",
    }
  }

  const lease = exactLease ?? await deps.createLiveWebhookLease({
    prNumber: command.prNumber,
    routeableDeploymentId: routeableDeployment.id,
    actorGithubUserId: command.actorGithubUserId,
    actorGithubLoginSnapshot: command.actorGithubLogin,
    scopeClass: command.scope.repositoryId == null ? "installation" : "repo",
    event: command.scope.event,
    installationId: command.scope.installationId,
    repositoryId: command.scope.repositoryId,
    action: command.scope.action,
    pullRequestNumber: command.scope.pullRequestNumber,
    ref: command.scope.ref,
    githubOwnerTypeSnapshot: ownerSnapshot.githubOwnerType,
    githubOwnerIdSnapshot: ownerSnapshot.githubOwnerId,
    githubOwnerLoginSnapshot: ownerSnapshot.githubOwnerLogin,
    reason: command.reason,
  })

  const operation = await deps.createOperation({
    requestId: command.requestId,
    operationType,
    input: command,
    actorGithubUserId: command.actorGithubUserId,
    actorGithubLoginSnapshot: command.actorGithubLogin,
    routeableDeploymentId: routeableDeployment.id,
    liveWebhookLeaseId: lease.id,
    status: "accepted",
  })

  await deps.queue.send({
    command: "reconcile_live_webhook_lease",
    operationId: operation.id,
    leaseId: lease.id,
  })
  await deps.createAuditEvent({
    operationId: operation.id,
    routeableDeploymentId: routeableDeployment.id,
    liveWebhookLeaseId: lease.id,
    eventType: "live_webhook_lease.ensure_requested",
    actorGithubUserId: command.actorGithubUserId,
    actorGithubLoginSnapshot: command.actorGithubLogin,
    details: {
      deploymentId: command.deploymentId,
      event: command.scope.event,
      installationId: command.scope.installationId,
      repositoryId: command.scope.repositoryId,
      action: command.scope.action,
      pullRequestNumber: command.scope.pullRequestNumber,
      ref: command.scope.ref,
    },
  })

  return {
    status: "accepted",
    operationId: operation.id,
    resourceId: lease.id,
  }
}
