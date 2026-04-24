import { applyAwsSession, assumeRole } from "./lib/aws-auth"
import { getConfig, imageUri } from "./lib/env"
import { fetchOutputs } from "./lib/outputs"
import { describeTaskDefinition, renderImage, registerTaskDefinition, deployService, waitForStability } from "./lib/ecs"

export async function deployCp() {
  const { registry, tier, sha, dryRun } = await getConfig()
  const environment = process.env.YAFFLE_ENVIRONMENT_NAME?.trim() || "main"
  const { cluster, service, appDeployerRoleArn } = await resolveControlPlaneDeploymentTarget()
  const family = service

  const image = `${imageUri(registry, "control-plane", tier)}:sha-${sha}`

  console.log(`Deploying control-plane: ${image} → ${cluster}/${service}`)

  applyAwsSession(await assumeRole(appDeployerRoleArn, "app-deployer"))

  const taskDef = await describeTaskDefinition(family)
  const rendered = renderControlPlaneTaskDefinition(
    renderImage(taskDef, "control-plane", image),
    await resolveControlPlaneSecretOverrides(environment),
  )

  if (dryRun) {
    console.log("[dry-run] Would register task definition and deploy service")
    return
  }

  const arn = await registerTaskDefinition(rendered)
  await deployService(cluster, service, arn)
  await waitForStability(cluster, service)
}

interface ControlPlaneSecretOverrides {
  providerDiscoveryAgentTokenSecretArn?: string
  providerDiscoveryCallbackSecretArn?: string
}

function renderControlPlaneTaskDefinition(
  taskDef: Record<string, any>,
  overrides: ControlPlaneSecretOverrides,
): Record<string, any> {
  const containers = taskDef.containerDefinitions as Array<Record<string, any>>

  return {
    ...taskDef,
    containerDefinitions: containers.map((container) => {
      if (container.name !== "control-plane") {
        return container
      }

      const secrets = Array.isArray(container.secrets) ? container.secrets as Array<Record<string, any>> : []
      const rewrittenSecrets = secrets.map((secret) => {
        if (
          secret.name === "YAFFLE_PROVIDER_DISCOVERY_AGENT_TOKEN"
          && overrides.providerDiscoveryAgentTokenSecretArn
        ) {
          return {
            ...secret,
            valueFrom: overrides.providerDiscoveryAgentTokenSecretArn,
          }
        }

        if (
          secret.name === "YAFFLE_PROVIDER_DISCOVERY_CALLBACK_SECRET"
          && overrides.providerDiscoveryCallbackSecretArn
        ) {
          return {
            ...secret,
            valueFrom: overrides.providerDiscoveryCallbackSecretArn,
          }
        }

        return secret
      })

      return {
        ...container,
        secrets: rewrittenSecrets,
      }
    }),
  }
}

async function resolveControlPlaneSecretOverrides(
  environment: string,
): Promise<ControlPlaneSecretOverrides> {
  const outputs = await fetchOutputs({
    workspace: "apps/provider-discovery-agent/infra",
    environment,
    wait: false,
  })

  return {
    providerDiscoveryAgentTokenSecretArn: typeof outputs.agent_token_secret_arn === "string"
      ? outputs.agent_token_secret_arn.trim()
      : undefined,
    providerDiscoveryCallbackSecretArn: typeof outputs.callback_secret_secret_arn === "string"
      ? outputs.callback_secret_secret_arn.trim()
      : undefined,
  }
}

async function resolveControlPlaneDeploymentTarget(): Promise<{ cluster: string; service: string; appDeployerRoleArn: string }> {
  const environment = process.env.YAFFLE_ENVIRONMENT_NAME?.trim() || "main"
  const overrideCluster = process.env.YAFFLE_CP_CLUSTER?.trim()
    || process.env.YAFFLE_ECS_CLUSTER?.trim()
  const overrideService = process.env.YAFFLE_CP_SERVICE?.trim()
  const overrideAppDeployerRoleArn = process.env.YAFFLE_APP_DEPLOYER_ROLE_ARN?.trim()

  if (overrideCluster && overrideService) {
    if (!overrideAppDeployerRoleArn) {
      throw new Error(
        "Set YAFFLE_APP_DEPLOYER_ROLE_ARN when overriding YAFFLE_CP_CLUSTER/YAFFLE_CP_SERVICE."
      )
    }

    return {
      cluster: overrideCluster,
      service: overrideService,
      appDeployerRoleArn: overrideAppDeployerRoleArn,
    }
  }

  const outputs = await fetchOutputs({
    workspace: "apps/control-plane/infra",
    environment,
    wait: false,
  })

  const cluster = typeof outputs.ecs_cluster_name === "string"
    ? outputs.ecs_cluster_name.trim()
    : overrideCluster ?? ""
  const service = typeof outputs.control_plane_service_name === "string"
    ? outputs.control_plane_service_name.trim()
    : overrideService ?? ""
  const appDeployerRoleArn = typeof outputs.app_deployer_role_arn === "string"
    ? outputs.app_deployer_role_arn.trim()
    : ""

  if (!cluster || !service || !appDeployerRoleArn) {
    throw new Error(
      "Could not determine control-plane cluster/service. "
      + "Set YAFFLE_CP_CLUSTER (or YAFFLE_ECS_CLUSTER) and YAFFLE_CP_SERVICE, "
      + "or ensure apps/control-plane/infra exports ecs_cluster_name, control_plane_service_name, and app_deployer_role_arn through Yaffle outputs.",
    )
  }

  return { cluster, service, appDeployerRoleArn }
}

if (import.meta.main) {
  await deployCp()
}
