import {
  markOperationFailed,
  markOperationRunning,
  markOperationSucceeded,
} from "./db/queries/operations.ts"
import {
  findRouteableDeploymentByExternalId,
  upsertRouteableDeployment,
} from "./db/queries/routeable-deployments.ts"
import { createTrafficControlAuditEvent } from "./db/queries/audit-events.ts"
import { createHookdeckRoutingClient } from "./hookdeck-client.ts"
import { buildHookdeckDestinationName } from "./hookdeck-routing.ts"

interface ReconcileRouteableDeploymentInput {
  operationId: string
  deploymentId: string
  command: {
    deploymentId: string
    prNumber: number
    environmentName: string
    environmentKind: "transient" | "named"
    ownerGithubUserId: number
    ownerGithubLogin: string
    receiverUrl: string
    receiverKind: "github_webhook"
    desiredState: "active" | "inactive" | "destroyed"
  }
}

interface ReconcileRouteableDeploymentDeps {
  markOperationRunning: typeof markOperationRunning
  markOperationSucceeded: typeof markOperationSucceeded
  markOperationFailed: typeof markOperationFailed
  upsertRouteableDeployment: typeof upsertRouteableDeployment
  findRouteableDeploymentByExternalId: typeof findRouteableDeploymentByExternalId
  createHookdeckRoutingClient: typeof createHookdeckRoutingClient
  createAuditEvent: typeof createTrafficControlAuditEvent
}

const defaultDeps: ReconcileRouteableDeploymentDeps = {
  markOperationRunning,
  markOperationSucceeded,
  markOperationFailed,
  upsertRouteableDeployment,
  findRouteableDeploymentByExternalId,
  createHookdeckRoutingClient,
  createAuditEvent: createTrafficControlAuditEvent,
}

export async function reconcileRouteableDeployment(
  input: ReconcileRouteableDeploymentInput,
  deps: ReconcileRouteableDeploymentDeps = defaultDeps,
): Promise<void> {
  await deps.markOperationRunning(input.operationId)

  try {
    const existingDeployment = await deps.findRouteableDeploymentByExternalId(input.command.deploymentId)
    const hookdeck = await deps.createHookdeckRoutingClient()
    const hookdeckDestination = await hookdeck.upsertDestination({
      name: existingDeployment?.hookdeckDestinationName
        ?? buildHookdeckDestinationName(input.command.deploymentId),
      description: `Routeable deployment for Yaffle PR ${input.command.prNumber}`,
      url: input.command.receiverUrl,
      pathForwardingDisabled: true,
    })

    const deployment = await deps.upsertRouteableDeployment({
      externalDeploymentId: input.command.deploymentId,
      prNumber: input.command.prNumber,
      environmentName: input.command.environmentName,
      environmentKind: input.command.environmentKind,
      ownerGithubUserId: input.command.ownerGithubUserId,
      ownerGithubLoginSnapshot: input.command.ownerGithubLogin,
      receiverUrl: input.command.receiverUrl,
      receiverKind: input.command.receiverKind,
      hookdeckDestinationId: hookdeckDestination.id,
      hookdeckDestinationName: hookdeckDestination.name ?? existingDeployment?.hookdeckDestinationName ?? buildHookdeckDestinationName(input.command.deploymentId),
      lastReconciledAt: new Date(),
      lastSyncError: null,
      state: input.command.desiredState,
    })

    await deps.markOperationSucceeded(input.operationId, {
      routeableDeploymentId: deployment.id,
      output: {
        deploymentId: deployment.id,
        externalDeploymentId: deployment.externalDeploymentId,
        state: deployment.state,
        hookdeckDestinationId: deployment.hookdeckDestinationId,
        hookdeckDestinationName: deployment.hookdeckDestinationName,
      },
    })
    await deps.createAuditEvent({
      operationId: input.operationId,
      routeableDeploymentId: deployment.id,
      eventType: "routeable_deployment.reconciled",
      actorGithubUserId: deployment.ownerGithubUserId,
      actorGithubLoginSnapshot: deployment.ownerGithubLoginSnapshot,
      details: {
        externalDeploymentId: deployment.externalDeploymentId,
        hookdeckDestinationId: deployment.hookdeckDestinationId,
        hookdeckDestinationName: deployment.hookdeckDestinationName,
        state: deployment.state,
      },
    })
  } catch (error) {
    await deps.markOperationFailed(input.operationId, {
      resultCode: "RECONCILE_ROUTEABLE_DEPLOYMENT_FAILED",
      resultMessage: error instanceof Error ? error.message : String(error),
    })
    await deps.createAuditEvent({
      operationId: input.operationId,
      eventType: "routeable_deployment.reconcile_failed",
      details: {
        deploymentId: input.deploymentId,
        error: error instanceof Error ? error.message : String(error),
      },
    })
    throw error
  }
}
