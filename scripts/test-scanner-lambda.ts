/**
 * Invoke the scanner Lambda's healthcheck mode.
 * Verifies: git, tar, Tailscale connectivity, secrets extension, secret access.
 *
 * Usage:
 *   node --import tsx scripts/test-scanner-lambda.ts
 *   node --import tsx scripts/test-scanner-lambda.ts --ping-url https://yaffle.tail66f312.ts.net:3000/api/health
 */

import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda"
import { fetchOutputs } from "./lib/outputs"
import { getConfig } from "./lib/env"

async function main() {
  const { region } = await getConfig()

  const outputs = await fetchOutputs({
    workspace: "apps/runner/infra",
    environment: "main",
  })

  const functionName = process.env.YAFFLE_SCANNER_FUNCTION
    ?? outputs.scanner_lambda_function_name as string

  // Parse --ping-url from args
  let pingUrl: string | undefined
  const pingIdx = process.argv.indexOf("--ping-url")
  if (pingIdx !== -1 && pingIdx + 1 < process.argv.length) {
    pingUrl = process.argv[pingIdx + 1]
  }
  const pingEq = process.argv.find((a) => a.startsWith("--ping-url="))
  if (pingEq) {
    pingUrl = pingEq.split("=").slice(1).join("=")
  }

  console.log(`Invoking healthcheck on ${functionName}...`)
  if (pingUrl) {
    console.log(`  ping URL: ${pingUrl}`)
  }

  const lambda = new LambdaClient({ region: region ?? "us-east-1" })

  const payload: Record<string, unknown> = { action: "healthcheck" }
  if (pingUrl) payload.pingUrl = pingUrl

  const result = await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "RequestResponse",
      Payload: new TextEncoder().encode(JSON.stringify(payload)),
    }),
  )

  const rawPayload = new TextDecoder().decode(result.Payload)

  // Check for Lambda-level errors (function crash, timeout, etc.)
  if (result.FunctionError) {
    console.error(`\nLambda function error: ${result.FunctionError}`)
    console.error(rawPayload)
    process.exit(1)
  }

  const response = JSON.parse(rawPayload)

  console.log()
  console.log(`Status: ${response.statusCode}`)
  console.log(`Result: ${response.body}`)
  console.log()

  if (response.checks) {
    for (const [name, check] of Object.entries(response.checks) as [string, { ok: boolean; detail?: string }][]) {
      const icon = check.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"
      console.log(`  ${icon} ${name}: ${check.detail ?? (check.ok ? "ok" : "failed")}`)
    }
  }

  console.log()
  process.exit(response.statusCode === 200 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
