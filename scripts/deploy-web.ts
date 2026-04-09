import { applyAwsSession, assumeRole } from "./lib/aws-auth"
import { getConfig, imageUri } from "./lib/env"
import { fetchOutputs } from "./lib/outputs"
import { describeTaskDefinition, renderImage, registerTaskDefinition, deployService, waitForStability } from "./lib/ecs"

export async function deployWeb() {
  const { registry, tier, sha, dryRun } = await getConfig()

  const [webOutputs, cpOutputs] = await Promise.all([
    fetchOutputs({ workspace: "apps/web/infra", environment: "main", wait: false }),
    fetchOutputs({ workspace: "apps/control-plane/infra", environment: "main", wait: false }),
  ])

  const cluster = cpOutputs.ecs_cluster_name as string
  const service = webOutputs.web_service_name as string
  const appDeployerRoleArn = webOutputs.app_deployer_role_arn as string

  if (!appDeployerRoleArn) {
    throw new Error("apps/web/infra must export app_deployer_role_arn for local deploys")
  }

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

if (import.meta.main) {
  await deployWeb()
}
