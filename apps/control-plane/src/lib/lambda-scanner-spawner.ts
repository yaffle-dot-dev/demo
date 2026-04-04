/**
 * Lambda Scanner Spawner
 *
 * Invokes an AWS Lambda function to run the scanner worker.
 * Lambda provides ~1 second cold starts vs 30-60 seconds for ECS Fargate,
 * making it ideal for the short-lived scan job.
 */

import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda"

import { getAwsClientConfig } from "./aws-client-config.ts"
import { logger } from "./telemetry.ts"

export interface LambdaScannerConfig {
  /** Lambda function name or ARN */
  functionName: string
  /** AWS region */
  region: string
  /** Control plane API URL (passed to scanner as YAFFLE_API_URL) */
  apiUrl: string
}

export class LambdaScannerSpawner {
  private readonly config: LambdaScannerConfig
  private readonly lambda: LambdaClient

  constructor(config: LambdaScannerConfig) {
    this.config = config
    this.lambda = new LambdaClient(getAwsClientConfig(config.region))
  }

  async spawnScanner(scanJobId: string, scanToken: string): Promise<void> {
    logger.info("Invoking Lambda scanner", {
      scanJobId,
      functionName: this.config.functionName,
    })

    const payload = {
      YAFFLE_SCAN_JOB_ID: scanJobId,
      YAFFLE_JOB_TOKEN: scanToken,
      YAFFLE_API_URL: this.config.apiUrl,
    }

    const result = await this.lambda.send(
      new InvokeCommand({
        FunctionName: this.config.functionName,
        InvocationType: "Event", // Async — don't wait for completion
        Payload: new TextEncoder().encode(JSON.stringify(payload)),
      }),
    )

    if (result.StatusCode !== 202) {
      throw new Error(`Lambda invocation failed: status ${result.StatusCode}`)
    }

    logger.info("Lambda scanner invoked", {
      scanJobId,
      statusCode: result.StatusCode,
    })
  }
}
