import { getConfig, imageUri } from "./lib/env"
import { fetchOutputs } from "./lib/outputs"
import { describeTaskDefinition, renderImage, registerTaskDefinition, deployService, waitForStability } from "./lib/ecs"

export async function deployWeb() {
  const { registry, tier, sha, dryRun } = await getConfig()

  const outputs = await fetchOutputs({
    workspace: "apps/web/infra",
    environment: "main",
    wait: false,
  })

  const cluster = outputs.ecs_cluster_name as string
  const service = outputs.ecs_service_name as string
  const family = service
  const image = `${imageUri(registry, "web", tier)}:sha-${sha}`

  console.log(`Deploying web: ${image} → ${cluster}/${service}`)

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
