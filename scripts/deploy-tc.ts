import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { parseArgs } from "node:util"

import { LambdaClient, UpdateFunctionCodeCommand } from "@aws-sdk/client-lambda"

import { buildTrafficController } from "./build-tc"
import { applyAwsSession, assumeRole } from "./lib/aws-auth"
import { getConfig } from "./lib/env"
import { fetchOutputs } from "./lib/outputs"

const REPO_ROOT = resolve(import.meta.dir, "..")
const DEFAULT_API_ZIP = resolve(REPO_ROOT, "dist/traffic-controller/api-lambda.zip")
const DEFAULT_RECONCILE_ZIP = resolve(REPO_ROOT, "dist/traffic-controller/reconcile-lambda.zip")
const TRAFFIC_CONTROLLER_INFRA_WORKSPACE = "apps/traffic-controller/infra"

interface DeployTrafficControllerArgs {
  environment: string
  skipBuild: boolean
  apiOnly: boolean
  reconcileOnly: boolean
}

interface TrafficControllerDeploymentTarget {
  apiFunctionName: string
  reconcileFunctionName: string
  appDeployerRoleArn: string
}

function parseDeployArgs(): DeployTrafficControllerArgs {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      env: { type: "string" },
      "skip-build": { type: "boolean", default: false },
      "api-only": { type: "boolean", default: false },
      "reconcile-only": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  })

  if (values.help) {
    console.log(`
Usage: deploy-tc.ts [options]

Options:
  --env <name>            Deploy to a named environment (defaults to main)
  --skip-build            Skip the local bundle/typecheck preflight
  --api-only              Deploy only the API Lambda
  --reconcile-only        Deploy only the reconcile Lambda
  --help                  Show this help
`)
    process.exit(0)
  }

  if (values["api-only"] && values["reconcile-only"]) {
    throw new Error("--api-only and --reconcile-only are mutually exclusive")
  }

  return {
    environment: values.env ?? "main",
    skipBuild: values["skip-build"] ?? false,
    apiOnly: values["api-only"] ?? false,
    reconcileOnly: values["reconcile-only"] ?? false,
  }
}

async function resolveTrafficControllerDeploymentTarget(environment: string): Promise<TrafficControllerDeploymentTarget> {
  const overrideApiFunctionName = process.env.YAFFLE_TC_API_FUNCTION?.trim()
  const overrideReconcileFunctionName = process.env.YAFFLE_TC_RECONCILE_FUNCTION?.trim()
  const overrideAppDeployerRoleArn = process.env.YAFFLE_APP_DEPLOYER_ROLE_ARN?.trim()

  if (overrideApiFunctionName && overrideReconcileFunctionName && overrideAppDeployerRoleArn) {
    return {
      apiFunctionName: overrideApiFunctionName,
      reconcileFunctionName: overrideReconcileFunctionName,
      appDeployerRoleArn: overrideAppDeployerRoleArn,
    }
  }

  const outputs = await fetchOutputs({
    workspace: TRAFFIC_CONTROLLER_INFRA_WORKSPACE,
    environment,
    wait: false,
  })

  const apiFunctionName = overrideApiFunctionName
    || (typeof outputs.api_lambda_function_name === "string" ? outputs.api_lambda_function_name.trim() : "")
  const reconcileFunctionName = overrideReconcileFunctionName
    || (typeof outputs.reconcile_lambda_function_name === "string" ? outputs.reconcile_lambda_function_name.trim() : "")
  const appDeployerRoleArn = overrideAppDeployerRoleArn
    || (typeof outputs.app_deployer_role_arn === "string" ? outputs.app_deployer_role_arn.trim() : "")

  if (!apiFunctionName || !reconcileFunctionName || !appDeployerRoleArn) {
    throw new Error(
      "Could not determine traffic-controller deployment target. "
      + "Set YAFFLE_TC_API_FUNCTION, YAFFLE_TC_RECONCILE_FUNCTION, and YAFFLE_APP_DEPLOYER_ROLE_ARN, "
      + `or ensure ${TRAFFIC_CONTROLLER_INFRA_WORKSPACE} exports api_lambda_function_name, reconcile_lambda_function_name, and app_deployer_role_arn through Yaffle outputs.`,
    )
  }

  return {
    apiFunctionName,
    reconcileFunctionName,
    appDeployerRoleArn,
  }
}

async function updateLambdaCode(
  lambda: LambdaClient,
  functionName: string,
  zipPath: string,
): Promise<void> {
  const zipBuffer = await readFile(zipPath)
  await lambda.send(new UpdateFunctionCodeCommand({
    FunctionName: functionName,
    ZipFile: new Uint8Array(zipBuffer),
  }))
}

export async function deployTrafficController(
  args: DeployTrafficControllerArgs = parseDeployArgs(),
): Promise<void> {
  const { dryRun, region } = await getConfig()

  if (!args.skipBuild) {
    await buildTrafficController()
  }

  const target = await resolveTrafficControllerDeploymentTarget(args.environment)

  const deployApi = !args.reconcileOnly
  const deployReconcile = !args.apiOnly

  console.log(`Deploying traffic-controller (${args.environment})`)
  if (deployApi) {
    console.log(`- API Lambda: ${DEFAULT_API_ZIP} -> ${target.apiFunctionName}`)
  }
  if (deployReconcile) {
    console.log(`- Reconcile Lambda: ${DEFAULT_RECONCILE_ZIP} -> ${target.reconcileFunctionName}`)
  }

  if (dryRun) {
    console.log("[dry-run] Would update Lambda function code")
    return
  }

  applyAwsSession(await assumeRole(target.appDeployerRoleArn, "app-deployer"))
  const lambda = new LambdaClient({ region: region ?? "us-east-1" })

  if (deployApi) {
    await updateLambdaCode(lambda, target.apiFunctionName, DEFAULT_API_ZIP)
    console.log(`Traffic-controller API Lambda updated: ${target.apiFunctionName}`)
  }

  if (deployReconcile) {
    await updateLambdaCode(lambda, target.reconcileFunctionName, DEFAULT_RECONCILE_ZIP)
    console.log(`Traffic-controller reconcile Lambda updated: ${target.reconcileFunctionName}`)
  }
}

if (import.meta.main) {
  await deployTrafficController()
}
