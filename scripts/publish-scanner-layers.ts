/**
 * Publish scanner Lambda layers to AWS.
 *
 * Builds layers via nix, publishes them via AWS Lambda API,
 * and outputs the ARNs for use in Terraform.
 *
 * Usage:
 *   nix run .#publish-scanner-layers
 *
 * Outputs layer ARNs to stdout as:
 *   git_layer_arn=arn:aws:lambda:...
 *   tailscale_layer_arn=arn:aws:lambda:...
 */

import { readFile } from "node:fs/promises"
import { LambdaClient, PublishLayerVersionCommand } from "@aws-sdk/client-lambda"
import { SSMClient, PutParameterCommand } from "@aws-sdk/client-ssm"
import { exec } from "./lib/exec"
import { getConfig } from "./lib/env"

async function publishLayer(
  lambda: LambdaClient,
  name: string,
  zipPath: string,
  description: string,
): Promise<string> {
  const zipBuffer = await readFile(zipPath)

  console.log(`Publishing layer: ${name} (${zipBuffer.length} bytes)`)

  const result = await lambda.send(
    new PublishLayerVersionCommand({
      LayerName: name,
      Content: { ZipFile: new Uint8Array(zipBuffer) },
      CompatibleRuntimes: ["nodejs24.x"],
      CompatibleArchitectures: ["arm64"],
      Description: description,
    }),
  )

  const arn = result.LayerVersionArn!
  console.log(`  → ${arn}`)
  return arn
}

const PARAM_PREFIX = "/yaffle/scanner/layers"

async function storeArn(ssm: SSMClient, name: string, arn: string): Promise<void> {
  const paramName = `${PARAM_PREFIX}/${name}`
  await ssm.send(
    new PutParameterCommand({
      Name: paramName,
      Value: arn,
      Type: "String",
      Overwrite: true,
    }),
  )
  console.log(`  → ${paramName} = ${arn}`)
}

async function main() {
  const { region } = await getConfig()
  const lambda = new LambdaClient({ region: region ?? "us-east-1" })
  const ssm = new SSMClient({ region: region ?? "us-east-1" })

  // Build tailscale layer via nix
  console.log("Building tailscale layer...")
  await exec(["nix", "build", ".#lambda-layer-tailscale", "-o", "result-tailscale-layer"])
  const tailscaleZip = "result-tailscale-layer/tailscale-layer.zip"

  // Publish layer
  const tailscaleArn = await publishLayer(
    lambda,
    "yaffle-tailscale",
    tailscaleZip,
    "Tailscale userspace networking extension for Lambda",
  )

  // Store ARN in Parameter Store for Terraform to read
  console.log("\nStoring layer ARN in Parameter Store...")
  await storeArn(ssm, "tailscale", tailscaleArn)

  console.log("\nDone. Terraform will read this via aws_ssm_parameter.")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
