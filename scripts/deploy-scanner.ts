import { LambdaClient, UpdateFunctionCodeCommand } from "@aws-sdk/client-lambda"

import { getConfig, imageUri } from "./lib/env"
import { fetchOutputs } from "./lib/outputs"

export async function deployScanner() {
  const { registry, tier, sha, dryRun, region } = await getConfig()

  const outputs = await fetchOutputs({
    workspace: "apps/runner/infra",
    environment: "main",
    wait: false,
  })

  const functionName = outputs.scanner_lambda_function_name as string
  const ecrUrl = outputs.scanner_ecr_repository_url as string
  const image = `${ecrUrl}:sha-${sha}`

  console.log(`Deploying scanner Lambda: ${image} → ${functionName}`)

  if (dryRun) {
    console.log("[dry-run] Would update Lambda function code")
    return
  }

  const lambda = new LambdaClient({ region: region ?? "us-east-1" })

  await lambda.send(
    new UpdateFunctionCodeCommand({
      FunctionName: functionName,
      ImageUri: image,
    }),
  )

  console.log(`Scanner Lambda updated: ${functionName}`)
}

if (import.meta.main) {
  await deployScanner()
}
