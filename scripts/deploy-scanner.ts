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

  const outputs = await fetchOutputs({
    workspace: "apps/runner/infra",
    environment: "main",
    wait: false,
  })

  const functionName = process.env.YAFFLE_SCANNER_FUNCTION
    ?? outputs.scanner_lambda_function_name as string
  const appDeployerRoleArn = outputs.app_deployer_role_arn as string
  const zipPath = process.env.YAFFLE_SCANNER_ZIP ?? "dist/scanner-lambda.zip"

  if (!appDeployerRoleArn) {
    throw new Error("apps/runner/infra must export app_deployer_role_arn for local deploys")
  }

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

if (import.meta.main) {
  await deployScanner()
}
