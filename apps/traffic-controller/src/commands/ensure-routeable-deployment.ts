import type { EnsureRouteableDeploymentRequest, TrafficControllerApiResponse } from "../contract.ts"
import {
  createTrafficControlOperation,
  findInFlightOperationByRequestIdAndType,
  type TrafficControlOperation,
} from "../db/queries/operations.ts"
import { findRouteableDeploymentByExternalId } from "../db/queries/routeable-deployments.ts"
import { createTrafficControlAuditEvent } from "../db/queries/audit-events.ts"
import type { ReconcileQueueClient } from "../reconcile-queue.ts"

interface EnsureRouteableDeploymentDeps {
  findExistingOperation: typeof findInFlightOperationByRequestIdAndType
  createOperation: typeof createTrafficControlOperation
  findRouteableDeploymentByExternalId: typeof findRouteableDeploymentByExternalId
  createAuditEvent: typeof createTrafficControlAuditEvent
  queue: ReconcileQueueClient
}

export function createEnsureRouteableDeploymentDeps(
  queue: ReconcileQueueClient,
): EnsureRouteableDeploymentDeps {
  return {
    findExistingOperation: findInFlightOperationByRequestIdAndType,
    createOperation: createTrafficControlOperation,
    findRouteableDeploymentByExternalId,
    createAuditEvent: createTrafficControlAuditEvent,
    queue,
  }
}

export function operationToApiResponse(
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

export async function ensureRouteableDeployment(
  command: EnsureRouteableDeploymentRequest,
  deps: EnsureRouteableDeploymentDeps,
): Promise<TrafficControllerApiResponse> {
  const existing = await deps.findExistingOperation(
    command.requestId,
    "ensure_routeable_deployment",
  )
  if (existing) {
    return operationToApiResponse(existing)
  }

  const operation = await deps.createOperation({
    requestId: command.requestId,
    operationType: "ensure_routeable_deployment",
    input: command,
    actorGithubUserId: command.ownerGithubUserId,
    actorGithubLoginSnapshot: command.ownerGithubLogin,
    status: "accepted",
  })

  try {
    const existingDeployment = await deps.findRouteableDeploymentByExternalId(command.deploymentId)
    await deps.createAuditEvent({
      operationId: operation.id,
      routeableDeploymentId: existingDeployment?.id,
      eventType: "routeable_deployment.ensure_requested",
      actorGithubUserId: command.ownerGithubUserId,
      actorGithubLoginSnapshot: command.ownerGithubLogin,
      details: {
        externalDeploymentId: command.deploymentId,
        desiredState: command.desiredState,
      },
    })
    await deps.queue.send({
      command: "reconcile_routeable_deployment",
      operationId: operation.id,
      routeableDeploymentId: existingDeployment?.id ?? command.deploymentId,
    })

    return {
      status: "accepted",
      operationId: operation.id,
      resourceId: existingDeployment?.id,
    }
  } catch (error) {
    return {
      status: "rejected",
      code: "QUEUE_ERROR",
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
