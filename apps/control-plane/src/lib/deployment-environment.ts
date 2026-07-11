export interface DeploymentEnvironmentInput {
  environmentKind: "named" | "transient"
  environmentName: string
  prNumber: number | null
}

export interface DeploymentExecutionEnvironment {
  environmentKind: "named" | "transient"
  environmentName: string
  sourcePrNumber: number | null
}

export function getDeploymentExecutionEnvironment(
  deployment: DeploymentEnvironmentInput,
): DeploymentExecutionEnvironment {
  return {
    environmentKind: deployment.environmentKind,
    environmentName: deployment.environmentName,
    sourcePrNumber: deployment.prNumber && deployment.prNumber > 0 ? deployment.prNumber : null,
  }
}
