/**
 * Deploy the scanner Lambda function.
 *
 * Updates the function code with the built zip.
 * Run build-scanner.ts first to create dist/scanner-lambda.zip.
 */

import { readFile } from "node:fs/promises"
import { LambdaClient, UpdateFunctionCodeCommand } from "@aws-sdk/client-lambda"

import { applyAwsSession, assumeRole } from "./lib/aws-auth"
import { getConfig } from "./lib/env"
import { fetchOutputs } from "./lib/outputs"

export async function deployScanner() {
  const { dryRun, region } = await getConfig()
  const { functionName, appDeployerRoleArn } = await resolveScannerDeploymentTarget()
  const zipPath = process.env.YAFFLE_SCANNER_ZIP ?? "dist/scanner-lambda.zip"

  console.log(`Deploying scanner Lambda: ${zipPath} → ${functionName}`)

  if (dryRun) {
    console.log("[dry-run] Would update Lambda function code")
    return
  }

  applyAwsSession(await assumeRole(appDeployerRoleArn, "app-deployer"))

  const zipBuffer = await readFile(zipPath)

  const lambda = new LambdaClient({ region: region ?? "us-east-1" })

  await lambda.send(
    new UpdateFunctionCodeCommand({
      FunctionName: functionName,
      ZipFile: new Uint8Array(zipBuffer),
    }),
  )

  console.log(`Scanner Lambda updated: ${functionName}`)
}

async function resolveScannerDeploymentTarget(): Promise<{ functionName: string; appDeployerRoleArn: string }> {
  const overrideFunctionName = process.env.YAFFLE_SCANNER_FUNCTION?.trim()
  const overrideAppDeployerRoleArn = process.env.YAFFLE_APP_DEPLOYER_ROLE_ARN?.trim()

  if (overrideFunctionName && overrideAppDeployerRoleArn) {
    return {
      functionName: overrideFunctionName,
      appDeployerRoleArn: overrideAppDeployerRoleArn,
    }
  }

  const outputs = await fetchOutputs({
    workspace: "apps/runner/infra",
    environment: "main",
    wait: false,
  })

  const functionName = overrideFunctionName
    || (typeof outputs.scanner_lambda_function_name === "string"
      ? outputs.scanner_lambda_function_name.trim()
      : "")
  const appDeployerRoleArn = overrideAppDeployerRoleArn
    || (typeof outputs.app_deployer_role_arn === "string"
      ? outputs.app_deployer_role_arn.trim()
      : "")

  if (!functionName || !appDeployerRoleArn) {
    throw new Error(
      "Could not determine scanner deployment target. "
      + "Set YAFFLE_SCANNER_FUNCTION and YAFFLE_APP_DEPLOYER_ROLE_ARN, "
      + "or ensure apps/runner/infra exports scanner_lambda_function_name and app_deployer_role_arn through Yaffle outputs.",
    )
  }

  return { functionName, appDeployerRoleArn }
}

if (import.meta.main) {
  await deployScanner()
}
