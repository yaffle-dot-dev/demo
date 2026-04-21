import type { EnvironmentKind } from "./config-toml.ts"

import { listLatestDeploymentsForOrg } from "../db/queries/workspace-deployments.ts"
import { events } from "./events.ts"

interface ConnectionReadinessEventDeps {
  listLatestDeploymentsForOrg: typeof listLatestDeploymentsForOrg
  emitDeploymentUpdate: typeof events.emitDeploymentUpdate
}

const defaultDeps: ConnectionReadinessEventDeps = {
  listLatestDeploymentsForOrg,
  emitDeploymentUpdate: events.emitDeploymentUpdate.bind(events),
}

export async function emitConnectionReadinessChangedForOrg(
  orgId: string,
  deps: ConnectionReadinessEventDeps = defaultDeps,
): Promise<number> {
  const deployments = await deps.listLatestDeploymentsForOrg(orgId)

  for (const deployment of deployments) {
    deps.emitDeploymentUpdate(
      deployment.id,
      deployment.orgId,
      deployment.repo,
      deployment.environmentKind as EnvironmentKind,
      deployment.environmentName,
    )
  }

  return deployments.length
}
