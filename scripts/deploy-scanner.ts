/**
 * Deploy the scanner Lambda function.
 *
 * Updates the function code with the built zip.
 * Run build-scanner.ts first to create dist/scanner-lambda.zip.
 */

import { readFile } from "node:fs/promises"
import { LambdaClient, UpdateFunctionCodeCommand } from "@aws-sdk/client-lambda"

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
  const zipPath = process.env.YAFFLE_SCANNER_ZIP ?? "dist/scanner-lambda.zip"

  console.log(`Deploying scanner Lambda: ${zipPath} → ${functionName}`)

  if (dryRun) {
    console.log("[dry-run] Would update Lambda function code")
    return
  }

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
