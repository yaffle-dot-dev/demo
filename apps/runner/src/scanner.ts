#!/usr/bin/env node
/**
 * Yaffle Scanner Worker — CLI entry point.
 *
 * Runs the scanner as a standalone process (ECS Fargate or local dev).
 * For Lambda, use scanner-lambda.ts instead.
 *
 * Environment variables:
 * - YAFFLE_SCAN_JOB_ID: The scan job ID to execute (required)
 * - YAFFLE_JOB_TOKEN: JWT token for API authentication (required)
 * - YAFFLE_API_URL: Control plane API URL (required)
 */

import { runScanner } from "./scanner-main.ts"

runScanner()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[scanner] Unhandled error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
