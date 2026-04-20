import { applyAwsSession, assumeRole } from "./lib/aws-auth"
import { getConfig, imageUri } from "./lib/env"
import { fetchOutputs } from "./lib/outputs"
import { describeTaskDefinition, renderImage, registerTaskDefinition, deployService, waitForStability } from "./lib/ecs"

export async function deployWeb() {
  const { registry, tier, sha, dryRun } = await getConfig()
  const { cluster, service, appDeployerRoleArn } = await resolveWebDeploymentTarget()

  const family = service
  const image = `${imageUri(registry, "web", tier)}:sha-${sha}`

  console.log(`Deploying web: ${image} → ${cluster}/${service}`)

  applyAwsSession(await assumeRole(appDeployerRoleArn, "app-deployer"))

  const taskDef = await describeTaskDefinition(family)
  const rendered = renderImage(taskDef, "web", image)

  if (dryRun) {
    console.log("[dry-run] Would register task definition and deploy service")
    return
  }

  const arn = await registerTaskDefinition(rendered)
  await deployService(cluster, service, arn)
  await waitForStability(cluster, service)
}

async function resolveWebDeploymentTarget(): Promise<{ cluster: string; service: string; appDeployerRoleArn: string }> {
  const overrideCluster = process.env.YAFFLE_WEB_CLUSTER?.trim()
    || process.env.YAFFLE_ECS_CLUSTER?.trim()
  const overrideService = process.env.YAFFLE_WEB_SERVICE?.trim()
  const overrideAppDeployerRoleArn = process.env.YAFFLE_APP_DEPLOYER_ROLE_ARN?.trim()

  if (overrideCluster || overrideService) {
    if (!overrideCluster || !overrideService) {
      throw new Error(
        "Set both YAFFLE_WEB_CLUSTER (or YAFFLE_ECS_CLUSTER) and YAFFLE_WEB_SERVICE when overriding the web deploy target.",
      )
    }

    if (!overrideAppDeployerRoleArn) {
      throw new Error(
        "Set YAFFLE_APP_DEPLOYER_ROLE_ARN when overriding YAFFLE_WEB_CLUSTER/YAFFLE_WEB_SERVICE.",
      )
    }

    return {
      cluster: overrideCluster,
      service: overrideService,
      appDeployerRoleArn: overrideAppDeployerRoleArn,
    }
  }

  const [webOutputs, cpOutputs] = await Promise.all([
    fetchOutputs({ workspace: "apps/web/infra", environment: "main", wait: false }),
    fetchOutputs({ workspace: "apps/control-plane/infra", environment: "main", wait: false }),
  ])

  const cluster = typeof cpOutputs.ecs_cluster_name === "string"
    ? cpOutputs.ecs_cluster_name.trim()
    : ""
  const service = typeof webOutputs.web_service_name === "string"
    ? webOutputs.web_service_name.trim()
    : ""
  const appDeployerRoleArn = overrideAppDeployerRoleArn
    || (typeof webOutputs.app_deployer_role_arn === "string"
      ? webOutputs.app_deployer_role_arn.trim()
      : "")

  if (!cluster || !service || !appDeployerRoleArn) {
    throw new Error(
      "Could not determine web cluster/service. "
      + "Set YAFFLE_WEB_CLUSTER (or YAFFLE_ECS_CLUSTER), YAFFLE_WEB_SERVICE, and YAFFLE_APP_DEPLOYER_ROLE_ARN, "
      + "or ensure apps/control-plane/infra exports ecs_cluster_name and apps/web/infra exports web_service_name and app_deployer_role_arn through Yaffle outputs.",
    )
  }

  return { cluster, service, appDeployerRoleArn }
}

if (import.meta.main) {
  await deployWeb()
}
