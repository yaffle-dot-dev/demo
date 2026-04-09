import { getConfig, imageUri } from "./lib/env"
import { fetchOutputs } from "./lib/outputs"
import { describeTaskDefinition, renderImage, registerTaskDefinition, deployService, waitForStability } from "./lib/ecs"

export async function deployCp() {
  const { registry, tier, sha, dryRun } = await getConfig()
  const { cluster, service } = await resolveControlPlaneDeploymentTarget()
  const family = service

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

async function resolveControlPlaneDeploymentTarget(): Promise<{ cluster: string; service: string }> {
  const overrideCluster = process.env.YAFFLE_CP_CLUSTER?.trim()
    || process.env.YAFFLE_ECS_CLUSTER?.trim()
  const overrideService = process.env.YAFFLE_CP_SERVICE?.trim()

  if (overrideCluster && overrideService) {
    return {
      cluster: overrideCluster,
      service: overrideService,
    }
  }

  const outputs = await fetchOutputs({
    workspace: "apps/control-plane/infra",
    environment: "main",
    wait: false,
  })

  const cluster = typeof outputs.ecs_cluster_name === "string"
    ? outputs.ecs_cluster_name.trim()
    : overrideCluster ?? ""
  const service = typeof outputs.control_plane_service_name === "string"
    ? outputs.control_plane_service_name.trim()
    : overrideService ?? ""

  if (!cluster || !service) {
    throw new Error(
      "Could not determine control-plane cluster/service. "
      + "Set YAFFLE_CP_CLUSTER (or YAFFLE_ECS_CLUSTER) and YAFFLE_CP_SERVICE, "
      + "or ensure apps/control-plane/infra exports ecs_cluster_name and control_plane_service_name through Yaffle outputs.",
    )
  }

  return { cluster, service }
}

if (import.meta.main) {
  await deployCp()
}
