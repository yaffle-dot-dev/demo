import {
  markOperationFailed,
  markOperationRunning,
  markOperationSucceeded,
} from "./db/queries/operations.ts"
import {
  findRouteableDeploymentByExternalId,
  upsertRouteableDeployment,
} from "./db/queries/routeable-deployments.ts"

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
}

const defaultDeps: ReconcileRouteableDeploymentDeps = {
  markOperationRunning,
  markOperationSucceeded,
  markOperationFailed,
  upsertRouteableDeployment,
  findRouteableDeploymentByExternalId,
}

export async function reconcileRouteableDeployment(
  input: ReconcileRouteableDeploymentInput,
  deps: ReconcileRouteableDeploymentDeps = defaultDeps,
): Promise<void> {
  await deps.markOperationRunning(input.operationId)

  try {
    const deployment = await deps.upsertRouteableDeployment({
      externalDeploymentId: input.command.deploymentId,
      prNumber: input.command.prNumber,
      environmentName: input.command.environmentName,
      environmentKind: input.command.environmentKind,
      ownerGithubUserId: input.command.ownerGithubUserId,
      ownerGithubLoginSnapshot: input.command.ownerGithubLogin,
      receiverUrl: input.command.receiverUrl,
      receiverKind: input.command.receiverKind,
      state: input.command.desiredState,
    })

    await deps.markOperationSucceeded(input.operationId, {
      routeableDeploymentId: deployment.id,
      output: {
        deploymentId: deployment.id,
        externalDeploymentId: deployment.externalDeploymentId,
        state: deployment.state,
      },
    })
  } catch (error) {
    await deps.markOperationFailed(input.operationId, {
      resultCode: "RECONCILE_ROUTEABLE_DEPLOYMENT_FAILED",
      resultMessage: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
