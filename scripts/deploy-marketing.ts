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

import { existsSync } from "node:fs"
import { $ } from "bun"
import { parseArgs } from "util"
import { assumeRole } from "./lib/aws-auth"
import { fetchOutputs } from "./lib/outputs"

type DeployTarget =
  | { type: "pr"; prNumber: number }
  | { type: "env"; name: string }

interface DeployConfig {
  target: DeployTarget
  wait: boolean
  skipBuild: boolean
  dryRun: boolean
}

const MARKETING_DIR = `${import.meta.dir}/../apps/marketing`
const MARKETING_ASTRO_CLI = `${MARKETING_DIR}/node_modules/astro/astro.js`

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

async function getYaffleOutputs(
  workspace: string,
  target: DeployTarget,
  wait: boolean
): Promise<Record<string, unknown>> {
  if (target.type === "pr") {
    return fetchOutputs({
      workspace,
      prNumber: target.prNumber,
      wait,
      waitTimeout: 600,
    })
  }

  return fetchOutputs({
    workspace,
    environment: target.name,
    wait,
    waitTimeout: 600,
  })
}

async function buildSite(siteUrl: string, dryRun: boolean): Promise<void> {
  console.log(`\nBuilding marketing site with SITE_URL=${siteUrl}...`)

  if (dryRun) {
    console.log(`[dry-run] Would run: ${process.execPath} ${MARKETING_ASTRO_CLI} build`)
    return
  }

  if (!existsSync(MARKETING_ASTRO_CLI)) {
    throw new Error(
      `Marketing build dependency missing at ${MARKETING_ASTRO_CLI}. Run 'bun install' from the repo root.`
    )
  }

  await $`${process.execPath} ${MARKETING_ASTRO_CLI} build`
    .env({ SITE_URL: siteUrl })
    .cwd(MARKETING_DIR)
}

async function syncToS3(
  bucket: string,
  deployRoleArn: string,
  deployerSession: Record<string, string> | undefined,
  dryRun: boolean
): Promise<void> {
  console.log(`\nSyncing to S3 bucket: ${bucket}...`)

  if (dryRun) {
    console.log("[dry-run] Would sync apps/marketing/dist/ to s3://" + bucket)
    return
  }

  const creds = await assumeRole(deployRoleArn, "deploy-marketing", deployerSession)

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
  deployerSession: Record<string, string> | undefined,
  dryRun: boolean
): Promise<void> {
  console.log(`\nInvalidating CloudFront distribution: ${distributionId}...`)

  if (dryRun) {
    console.log("[dry-run] Would invalidate CloudFront paths: /* /_astro/*")
    return
  }

  const creds = await assumeRole(invalidationRoleArn, "deploy-invalidation", deployerSession)

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
  const siteDeployerRoleArn = marketingOutputs.site_deployer_role_arn as string
  const siteUrl = frontendOutputs.site_url as string
  const distributionId = frontendOutputs.cloudfront_distribution_id as string
  const invalidationRoleArn = frontendOutputs.invalidation_role_arn as string

  if (!siteDeployerRoleArn) {
    throw new Error("apps/marketing/infra must export site_deployer_role_arn for local deploys")
  }

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

  const deployerSession = config.dryRun
    ? undefined
    : await assumeRole(siteDeployerRoleArn, "site-deployer")

  // 3. Sync to S3
  await syncToS3(bucket, deployRoleArn, deployerSession, config.dryRun)

  // 4. Invalidate CloudFront
  await invalidateCloudFront(distributionId, invalidationRoleArn, deployerSession, config.dryRun)

  console.log("\n=== Deploy Complete ===")
  console.log(`Site: ${siteUrl}`)
}

main().catch((err) => {
  console.error("Deploy failed:", err.message)
  process.exit(1)
})
