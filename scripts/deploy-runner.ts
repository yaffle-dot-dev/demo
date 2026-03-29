import { getConfig, imageUri } from "./lib/env"
import { fetchOutputs } from "./lib/outputs"
import { describeTaskDefinition, renderImage, registerTaskDefinition } from "./lib/ecs"

export async function deployRunner() {
  const { registry, tier, sha, dryRun } = await getConfig()

  const outputs = await fetchOutputs({
    workspace: "apps/runner/infra",
    environment: "main",
    wait: false,
  })

  const family = outputs.task_definition_family as string
  const image = `${imageUri(registry, "runner", tier)}:sha-${sha}`

  console.log(`Deploying runner task def: ${image} → ${family}`)

  const taskDef = await describeTaskDefinition(family)
  const rendered = renderImage(taskDef, "runner", image)

  if (dryRun) {
    console.log("[dry-run] Would register task definition")
    return
  }

  await registerTaskDefinition(rendered)
  // No service update — runner is ephemeral. CP uses the family name
  // and picks up the latest revision on the next RunTask call.
}

if (import.meta.main) {
  await deployRunner()
}
