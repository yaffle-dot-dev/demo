import { getConfig, imageUri } from "./lib/env"
import { fetchOutputs } from "./lib/outputs"
import { describeTaskDefinition, renderImage, registerTaskDefinition } from "./lib/ecs"

export async function deployRunner() {
  const { registry, tier, sha, dryRun } = await getConfig()
  const family = await resolveRunnerTaskDefinition()
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

async function resolveRunnerTaskDefinition(): Promise<string> {
  const override = process.env.YAFFLE_RUNNER_TASK_DEFINITION?.trim()
    || process.env.YAFFLE_RUNNER_TASK_DEFINITION_FAMILY?.trim()
    || process.env.YAFFLE_ECS_TASK_DEFINITION?.trim()

  if (override) {
    return override
  }

  const outputs = await fetchOutputs({
    workspace: "apps/runner/infra",
    environment: "main",
    wait: false,
  })

  const family = typeof outputs.task_definition_family === "string"
    ? outputs.task_definition_family.trim()
    : ""

  if (!family) {
    throw new Error(
      "Could not determine runner task definition. "
      + "Set YAFFLE_RUNNER_TASK_DEFINITION (or YAFFLE_RUNNER_TASK_DEFINITION_FAMILY / YAFFLE_ECS_TASK_DEFINITION), "
      + "or ensure apps/runner/infra exports task_definition_family through Yaffle outputs.",
    )
  }

  return family
}

if (import.meta.main) {
  await deployRunner()
}
