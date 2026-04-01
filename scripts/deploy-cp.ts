import { getConfig, imageUri } from "./lib/env"
import { fetchOutputs } from "./lib/outputs"
import { describeTaskDefinition, renderImage, registerTaskDefinition, deployService, waitForStability } from "./lib/ecs"

export async function deployCp() {
  const { registry, tier, sha, dryRun } = await getConfig()

  const outputs = await fetchOutputs({
    workspace: "apps/control-plane/infra",
    environment: "main",
    wait: false,
  })

  const cluster = (outputs.ecs_cluster_name ?? process.env.YAFFLE_ECS_CLUSTER) as string
  const service = (outputs.control_plane_service_name ?? process.env.YAFFLE_CP_SERVICE) as string
  const family = service

  if (!cluster || !service) {
    throw new Error(
      "Could not determine cluster/service from outputs. " +
      "Set YAFFLE_ECS_CLUSTER and YAFFLE_CP_SERVICE env vars, or ensure the CP infra has been applied through Yaffle."
    )
  }
  const image = `${imageUri(registry, "control-plane", tier)}:sha-${sha}`

  console.log(`Deploying control-plane: ${image} → ${cluster}/${service}`)

  const taskDef = await describeTaskDefinition(family)
  const rendered = renderImage(taskDef, "control-plane", image)

  if (dryRun) {
    console.log("[dry-run] Would register task definition and deploy service")
    return
  }

  const arn = await registerTaskDefinition(rendered)
  await deployService(cluster, service, arn)
  await waitForStability(cluster, service)
}

if (import.meta.main) {
  await deployCp()
}
