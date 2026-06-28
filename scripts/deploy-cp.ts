import type { DeployableArtifactResolution } from "./ci/deployables/types"

import { applyAwsSession, assumeRole } from "./lib/aws-auth"
import { getConfig, imageUri } from "./lib/env"
import { fetchOutputs } from "./lib/outputs"
import {
  describeTaskDefinition,
  renderContainerHealthCheck,
  renderImage,
  registerTaskDefinition,
  deployService,
  waitForStability,
} from "./lib/ecs"
import { isMain } from "./lib/module"

const CONTROL_PLANE_HEALTHCHECK_COMMAND = [
  "CMD",
  "/bin/node",
  "-e",
  "fetch('http://localhost:3000/api/health').then(r=>{if(!r.ok)process.exit(1);process.exit(0)}).catch(()=>process.exit(1))",
]

export async function deployCp(artifact?: DeployableArtifactResolution) {
  const { registry, tier, sha, dryRun } = await getConfig()
  const environment = process.env.YAFFLE_ENVIRONMENT_NAME?.trim() || "main"
  const { cluster, service, appDeployerRoleArn } = await resolveControlPlaneDeploymentTarget()
  const family = service

  const image = artifact?.artifactRef ?? `${imageUri(registry, "control-plane", tier)}:sha-${sha}`

  console.log(`Deploying control-plane: ${image} → ${cluster}/${service}`)

  applyAwsSession(await assumeRole(appDeployerRoleArn, "app-deployer"))

  const taskDef = await describeTaskDefinition(family)
  const rendered = renderControlPlaneTaskDefinition(
    renderContainerHealthCheck(
      renderImage(taskDef, "control-plane", image),
      "control-plane",
      CONTROL_PLANE_HEALTHCHECK_COMMAND,
    ),
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
  const overrideAgentTokenSecretArn = process.env.YAFFLE_PROVIDER_DISCOVERY_AGENT_TOKEN_SECRET_ARN?.trim()
  const overrideCallbackSecretArn = process.env.YAFFLE_PROVIDER_DISCOVERY_CALLBACK_SECRET_ARN?.trim()

  if (overrideAgentTokenSecretArn || overrideCallbackSecretArn) {
    return {
      providerDiscoveryAgentTokenSecretArn: overrideAgentTokenSecretArn || undefined,
      providerDiscoveryCallbackSecretArn: overrideCallbackSecretArn || undefined,
    }
  }

  const controlPlaneOutputs = await fetchOutputs({
    workspace: "apps/control-plane/infra",
    environment,
  })

  const providerDiscoveryAgentTokenSecretArn = typeof controlPlaneOutputs.provider_discovery_agent_token_secret_arn === "string"
    ? controlPlaneOutputs.provider_discovery_agent_token_secret_arn.trim()
    : undefined
  const providerDiscoveryCallbackSecretArn = typeof controlPlaneOutputs.provider_discovery_callback_secret_arn === "string"
    ? controlPlaneOutputs.provider_discovery_callback_secret_arn.trim()
    : undefined

  if (providerDiscoveryAgentTokenSecretArn && providerDiscoveryCallbackSecretArn) {
    return {
      providerDiscoveryAgentTokenSecretArn,
      providerDiscoveryCallbackSecretArn,
    }
  }

  const providerDiscoveryOutputs = await fetchOutputs({
    workspace: "apps/provider-discovery-agent/infra",
    environment,
  })

  return {
    providerDiscoveryAgentTokenSecretArn: providerDiscoveryAgentTokenSecretArn
      ?? (typeof providerDiscoveryOutputs.agent_token_secret_arn === "string"
        ? providerDiscoveryOutputs.agent_token_secret_arn.trim()
        : undefined),
    providerDiscoveryCallbackSecretArn: providerDiscoveryCallbackSecretArn
      ?? (typeof providerDiscoveryOutputs.callback_secret_secret_arn === "string"
        ? providerDiscoveryOutputs.callback_secret_secret_arn.trim()
        : undefined),
  }
}

export async function resolveControlPlaneDeploymentTarget(): Promise<{ cluster: string; service: string; appDeployerRoleArn: string }> {
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

if (isMain(import.meta)) {
  await deployCp()
}
