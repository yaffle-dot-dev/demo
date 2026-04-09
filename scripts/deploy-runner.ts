import { applyAwsSession, assumeRole } from "./lib/aws-auth"
import { getConfig, imageUri } from "./lib/env"
import { fetchOutputs } from "./lib/outputs"
import { describeTaskDefinition, renderImage, registerTaskDefinition } from "./lib/ecs"

export async function deployRunner() {
  const { registry, tier, sha, dryRun } = await getConfig()
  const { family, appDeployerRoleArn } = await resolveRunnerTaskDefinition()
  const image = `${imageUri(registry, "runner", tier)}:sha-${sha}`

  console.log(`Deploying runner task def: ${image} → ${family}`)

  applyAwsSession(await assumeRole(appDeployerRoleArn, "app-deployer"))

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

async function resolveRunnerTaskDefinition(): Promise<{ family: string; appDeployerRoleArn: string }> {
  const override = process.env.YAFFLE_RUNNER_TASK_DEFINITION?.trim()
    || process.env.YAFFLE_RUNNER_TASK_DEFINITION_FAMILY?.trim()
    || process.env.YAFFLE_ECS_TASK_DEFINITION?.trim()

  if (override) {
    const appDeployerRoleArn = process.env.YAFFLE_APP_DEPLOYER_ROLE_ARN?.trim() ?? ""

    if (!appDeployerRoleArn) {
      throw new Error(
        "Set YAFFLE_APP_DEPLOYER_ROLE_ARN when overriding YAFFLE_RUNNER_TASK_DEFINITION."
      )
    }

    return { family: override, appDeployerRoleArn }
  }

  const outputs = await fetchOutputs({
    workspace: "apps/runner/infra",
    environment: "main",
    wait: false,
  })

  const family = typeof outputs.task_definition_family === "string"
    ? outputs.task_definition_family.trim()
    : ""
  const appDeployerRoleArn = typeof outputs.app_deployer_role_arn === "string"
    ? outputs.app_deployer_role_arn.trim()
    : ""

  if (!family || !appDeployerRoleArn) {
    throw new Error(
      "Could not determine runner task definition. "
      + "Set YAFFLE_RUNNER_TASK_DEFINITION (or YAFFLE_RUNNER_TASK_DEFINITION_FAMILY / YAFFLE_ECS_TASK_DEFINITION), "
      + "or ensure apps/runner/infra exports task_definition_family and app_deployer_role_arn through Yaffle outputs.",
    )
  }

  return { family, appDeployerRoleArn }
}

if (import.meta.main) {
  await deployRunner()
}
