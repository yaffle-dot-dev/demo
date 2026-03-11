#!/usr/bin/env bun
/**
 * Deploy marketing site to S3/CloudFront.
 *
 * This script is the single source of truth for marketing deploys.
 * Both GitHub Actions and local deploys use this script.
 *
 * Usage:
 *   # For PR preview
 *   bun run scripts/deploy-marketing.ts --pr 123
 *
 *   # For a named environment (main, staging, etc.)
 *   bun run scripts/deploy-marketing.ts --env main
 *
 *   # Auto-detect from current git branch
 *   bun run scripts/deploy-marketing.ts
 *
 *   # Skip waiting for infra (if you know it's ready)
 *   bun run scripts/deploy-marketing.ts --pr 123 --no-wait
 *
 * Environment:
 *   GITHUB_TOKEN or YAFFLE_TOKEN - For fetching Yaffle outputs (falls back to `gh auth token`)
 *   AWS_REGION - AWS region (default: us-east-1)
 *   AWS credentials - Via env vars, ~/.aws/credentials, or IAM role
 *
 * What it does:
 *   1. Fetch infrastructure outputs from Yaffle (bucket, CloudFront, roles)
 *   2. Build the Astro site with the correct SITE_URL
 *   3. Assume the deploy role and sync to S3
 *   4. Assume the invalidation role and invalidate CloudFront
 */

import { $ } from "bun"
import { parseArgs } from "util"

interface YaffleOutputs {
  previewId: string
  status: string
  outputs: Record<string, { value: unknown; sensitive?: boolean }> | null
}

type DeployTarget =
  | { type: "pr"; prNumber: number }
  | { type: "env"; name: string }

interface DeployConfig {
  target: DeployTarget
  wait: boolean
  skipBuild: boolean
  dryRun: boolean
}

const AWS_REGION = process.env.AWS_REGION || "us-east-1"
const YAFFLE_API_URL = process.env.YAFFLE_API_URL || "https://yaffle.local:6969"

async function getCurrentBranch(): Promise<string> {
  const branch = await $`git rev-parse --abbrev-ref HEAD`.text()
  return branch.trim()
}

async function parseCliArgs(): Promise<DeployConfig> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      pr: { type: "string" },
      env: { type: "string" },
      wait: { type: "boolean", default: true },
      "no-wait": { type: "boolean", default: false },
      "skip-build": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  })

  if (values.help) {
    console.log(`
Usage: deploy-marketing.ts [options]

Options:
  --pr <number>     Deploy PR preview environment
  --env <name>      Deploy to named environment (main, staging, etc.)
  --no-wait         Don't wait for Yaffle infrastructure
  --skip-build      Skip building the site (use existing dist/)
  --dry-run         Show what would be done without doing it
  --help            Show this help

If neither --pr nor --env is specified, infers from current git branch.
`)
    process.exit(0)
  }

  let target: DeployTarget

  if (values.pr) {
    target = { type: "pr", prNumber: parseInt(values.pr, 10) }
  } else if (values.env) {
    target = { type: "env", name: values.env }
  } else {
    // Infer from git branch
    const branch = await getCurrentBranch()
    if (branch === "main" || branch === "master") {
      target = { type: "env", name: branch }
    } else {
      console.error(`Error: On branch '${branch}'. Specify --pr <number> or --env <name>`)
      console.error("       (Only main/master auto-deploy without flags)")
      process.exit(1)
    }
  }

  return {
    target,
    wait: !values["no-wait"],
    skipBuild: values["skip-build"] ?? false,
    dryRun: values["dry-run"] ?? false,
  }
}

async function getGitHubToken(): Promise<string> {
  // Check env vars first
  const envToken = process.env.YAFFLE_TOKEN || process.env.GITHUB_TOKEN
  if (envToken) return envToken

  // Fall back to gh CLI
  try {
    const token = await $`gh auth token`.text()
    return token.trim()
  } catch {
    throw new Error(
      "No GitHub token found. Set GITHUB_TOKEN, YAFFLE_TOKEN, or run 'gh auth login'"
    )
  }
}

async function getYaffleOutputs(
  workspace: string,
  target: DeployTarget,
  wait: boolean
): Promise<Record<string, unknown>> {
  const token = await getGitHubToken()

  // Get org/repo from git
  const remote = await $`git remote get-url origin`.text()
  const match = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/)
  if (!match) {
    throw new Error("Could not determine org/repo from git remote")
  }
  const [, org, repo] = match

  const args = [
    "--workspace", workspace,
    "--format", "json",
  ]

  if (target.type === "pr") {
    args.push("--pr", String(target.prNumber))
  } else {
    args.push("--env", target.name)
  }

  if (wait) {
    args.push("--wait")
    args.push("--timeout", "600")
  }

  console.log(`Fetching outputs for ${org}/${repo} workspace=${workspace}...`)

  // Use yaffle-outputs CLI
  const proc = $`bun run ${import.meta.dir}/../packages/cli/src/outputs.ts ${args}`
    .env({
      GITHUB_TOKEN: token,
      YAFFLE_API_URL,
      // Allow self-signed certs for local dev
      NODE_TLS_REJECT_UNAUTHORIZED: YAFFLE_API_URL.includes("localhost") || YAFFLE_API_URL.includes(".local") ? "0" : "1",
    })
    .quiet()

  let output: string
  try {
    output = await proc.text()
  } catch (err: unknown) {
    // Get stderr for debugging
    console.error(`[error] yaffle-outputs failed:`)
    if (err && typeof err === "object" && "stderr" in err) {
      const stderr = err.stderr
      console.error(typeof stderr === "string" ? stderr : String(stderr))
    } else if (err instanceof Error) {
      console.error(err.message)
    }
    throw err
  }

  let result: YaffleOutputs
  try {
    result = JSON.parse(output) as YaffleOutputs
  } catch {
    console.error(`[error] Failed to parse yaffle-outputs response:`)
    console.error(output)
    throw new Error(`Invalid JSON from yaffle-outputs`)
  }

  if (!result.outputs) {
    throw new Error(`No outputs from Yaffle for ${workspace}`)
  }

  // Flatten outputs to just values
  const flat: Record<string, unknown> = {}
  for (const [key, output] of Object.entries(result.outputs)) {
    flat[key] = output.value
  }
  return flat
}

async function buildSite(siteUrl: string, dryRun: boolean): Promise<void> {
  console.log(`\nBuilding marketing site with SITE_URL=${siteUrl}...`)

  if (dryRun) {
    console.log("[dry-run] Would run: bun run build")
    return
  }

  await $`bun run build`.env({ SITE_URL: siteUrl }).cwd("apps/marketing")
}

async function assumeRole(roleArn: string): Promise<Record<string, string>> {
  console.log(`Assuming role: ${roleArn}`)

  const result = await $`aws sts assume-role \
    --role-arn ${roleArn} \
    --role-session-name deploy-marketing \
    --duration-seconds 3600 \
    --region ${AWS_REGION}`.json() as {
      Credentials: {
        AccessKeyId: string
        SecretAccessKey: string
        SessionToken: string
      }
    }

  return {
    AWS_ACCESS_KEY_ID: result.Credentials.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: result.Credentials.SecretAccessKey,
    AWS_SESSION_TOKEN: result.Credentials.SessionToken,
    AWS_REGION,
  }
}

async function syncToS3(
  bucket: string,
  deployRoleArn: string,
  dryRun: boolean
): Promise<void> {
  console.log(`\nSyncing to S3 bucket: ${bucket}...`)

  if (dryRun) {
    console.log("[dry-run] Would sync apps/marketing/dist/ to s3://" + bucket)
    return
  }

  const creds = await assumeRole(deployRoleArn)

  // Sync immutable assets with long cache
  await $`aws s3 sync apps/marketing/dist/ s3://${bucket}/ \
    --delete \
    --cache-control "public, max-age=31536000, immutable" \
    --exclude "*" \
    --include "_astro/*"`.env(creds)

  // Sync everything else with short cache
  await $`aws s3 sync apps/marketing/dist/ s3://${bucket}/ \
    --delete \
    --cache-control "public, max-age=0, must-revalidate" \
    --exclude "_astro/*"`.env(creds)
}

async function invalidateCloudFront(
  distributionId: string,
  invalidationRoleArn: string,
  dryRun: boolean
): Promise<void> {
  console.log(`\nInvalidating CloudFront distribution: ${distributionId}...`)

  if (dryRun) {
    console.log("[dry-run] Would invalidate CloudFront paths: /* /_astro/*")
    return
  }

  const creds = await assumeRole(invalidationRoleArn)

  await $`aws cloudfront create-invalidation \
    --distribution-id ${distributionId} \
    --paths "/*" "/_astro/*"`.env(creds)
}

async function main(): Promise<void> {
  const config = await parseCliArgs()

  const targetLabel = config.target.type === "pr"
    ? `PR #${config.target.prNumber}`
    : `env: ${config.target.name}`

  console.log("=== Marketing Site Deploy ===")
  console.log(`Target: ${targetLabel}`)
  if (config.dryRun) console.log("(dry-run mode)")

  // 1. Fetch infrastructure outputs from Yaffle
  const [marketingOutputs, frontendOutputs] = await Promise.all([
    getYaffleOutputs("apps/marketing/infra", config.target, config.wait),
    getYaffleOutputs("apps/infra", config.target, config.wait),
  ])

  const bucket = marketingOutputs.primary_bucket_name as string
  const deployRoleArn = marketingOutputs.deploy_role_arn as string
  const siteUrl = frontendOutputs.site_url as string
  const distributionId = frontendOutputs.cloudfront_distribution_id as string
  const invalidationRoleArn = frontendOutputs.invalidation_role_arn as string

  console.log("\nInfrastructure:")
  console.log(`  Bucket: ${bucket}`)
  console.log(`  Site URL: ${siteUrl}`)
  console.log(`  CloudFront: ${distributionId}`)

  // 2. Build the site
  if (!config.skipBuild) {
    await buildSite(siteUrl, config.dryRun)
  } else {
    console.log("\nSkipping build (--skip-build)")
  }

  // 3. Sync to S3
  await syncToS3(bucket, deployRoleArn, config.dryRun)

  // 4. Invalidate CloudFront
  await invalidateCloudFront(distributionId, invalidationRoleArn, config.dryRun)

  console.log("\n=== Deploy Complete ===")
  console.log(`Site: ${siteUrl}`)
}

main().catch((err) => {
  console.error("Deploy failed:", err.message)
  process.exit(1)
})
