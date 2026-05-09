#!/usr/bin/env node
/**
 * Deploy marketing site to S3/CloudFront.
 */

import { assumeRole } from "./lib/aws-auth"
import { importMetaDir, isMain } from "./lib/module"
import {
  type DeployConfig,
  type DeployTarget,
  formatDeployTarget,
  formatStaticSiteUrl,
  invalidateStaticSiteCache,
  loadOutputsForTarget,
  loadStaticSiteInfrastructure,
  parseStaticSiteDeployArgs,
  runStaticSiteBuild,
  syncStaticSiteToS3,
} from "./lib/static-site-deploy"

interface StripePricing {
  pro: {
    amount: number
    interval: string
    price_id: string
    product_id: string
  }
  team: {
    amount: number
    interval: string
    price_id: string
    product_id: string
  }
  free_limits: {
    concurrent_preview_branches: number
    preview_creations_per_month: number
    named_environments: number
  }
}

function assertNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid marketing pricing field: ${name}`)
  }

  return value.trim()
}

function assertFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid marketing pricing field: ${name}`)
  }

  return value
}

function validatePricing(pricing: StripePricing): StripePricing {
  return {
    pro: {
      amount: assertFiniteNumber(pricing.pro?.amount, "stripe_pricing.pro.amount"),
      interval: assertNonEmptyString(pricing.pro?.interval, "stripe_pricing.pro.interval"),
      price_id: assertNonEmptyString(pricing.pro?.price_id, "stripe_pricing.pro.price_id"),
      product_id: assertNonEmptyString(pricing.pro?.product_id, "stripe_pricing.pro.product_id"),
    },
    team: {
      amount: assertFiniteNumber(pricing.team?.amount, "stripe_pricing.team.amount"),
      interval: assertNonEmptyString(pricing.team?.interval, "stripe_pricing.team.interval"),
      price_id: assertNonEmptyString(pricing.team?.price_id, "stripe_pricing.team.price_id"),
      product_id: assertNonEmptyString(pricing.team?.product_id, "stripe_pricing.team.product_id"),
    },
    free_limits: {
      concurrent_preview_branches: assertFiniteNumber(
        pricing.free_limits?.concurrent_preview_branches,
        "stripe_pricing.free_limits.concurrent_preview_branches"
      ),
      preview_creations_per_month: assertFiniteNumber(
        pricing.free_limits?.preview_creations_per_month,
        "stripe_pricing.free_limits.preview_creations_per_month"
      ),
      named_environments: assertFiniteNumber(
        pricing.free_limits?.named_environments,
        "stripe_pricing.free_limits.named_environments"
      ),
    },
  }
}

const MARKETING_DIR = `${importMetaDir(import.meta)}/../apps/marketing`

async function loadMarketingInfrastructure(target: DeployTarget, wait: boolean): Promise<{
  siteInfra: Awaited<ReturnType<typeof loadStaticSiteInfrastructure>>
  pricing: StripePricing
}> {
  const [siteInfra, sharedOutputs] = await Promise.all([
    loadStaticSiteInfrastructure({
      siteWorkspace: "apps/marketing/infra",
      humanDeployerRoleOutput: "site_deployer_role_arn",
      target,
      wait,
    }),
    loadOutputsForTarget("infra/shared", { type: "env", name: "main" }, wait),
  ])

  const pricing = sharedOutputs.stripe_pricing as StripePricing | undefined

  if (!pricing) {
    throw new Error("infra/shared must export stripe_pricing for marketing pricing")
  }

  return {
    siteInfra,
    pricing: validatePricing(pricing),
  }
}

export async function buildMarketingSite(
  target: DeployTarget,
  wait: boolean,
  dryRun: boolean,
): Promise<void> {
  const { siteInfra, pricing } = await loadMarketingInfrastructure(target, wait)
  await buildSite(siteInfra.siteUrl, pricing, dryRun)
}

async function buildSite(siteUrl: string, pricing: StripePricing, dryRun: boolean): Promise<void> {
  console.log(`\nUsing SITE_URL=${siteUrl} for marketing build...`)

  await runStaticSiteBuild({
    appDir: MARKETING_DIR,
    appLabel: "marketing",
    dryRun,
    env: {
      SITE_URL: siteUrl,
      PUBLIC_STRIPE_PRO_AMOUNT: String(pricing.pro.amount),
      PUBLIC_STRIPE_PRO_INTERVAL: pricing.pro.interval,
      PUBLIC_STRIPE_TEAM_AMOUNT: String(pricing.team.amount),
      PUBLIC_STRIPE_TEAM_INTERVAL: pricing.team.interval,
      PUBLIC_YAFFLE_FREE_LIMIT_CONCURRENT_PREVIEWS: String(
        pricing.free_limits.concurrent_preview_branches
      ),
      PUBLIC_YAFFLE_FREE_LIMIT_MONTHLY_PREVIEWS: String(
        pricing.free_limits.preview_creations_per_month
      ),
      PUBLIC_YAFFLE_FREE_LIMIT_NAMED_ENVIRONMENTS: String(
        pricing.free_limits.named_environments
      ),
    },
  })
}

export async function deployMarketingSite(config: DeployConfig): Promise<void> {
  const targetLabel = formatDeployTarget(config.target)

  console.log("=== Marketing Site Deploy ===")
  console.log(`Target: ${targetLabel}`)
  if (config.dryRun) console.log("(dry-run mode)")

  const { siteInfra, pricing } = await loadMarketingInfrastructure(config.target, config.wait)

  console.log("\nInfrastructure:")
  console.log(`  Bucket: ${siteInfra.bucket}`)
  console.log(`  Site URL: ${siteInfra.siteUrl}`)
  console.log(`  CloudFront: ${siteInfra.distributionId}`)

  if (!config.skipBuild) {
    await buildSite(siteInfra.siteUrl, pricing, config.dryRun)
  } else {
    console.log("\nSkipping build (--skip-build)")
  }

  const deployerSession = config.dryRun
    ? undefined
    : await assumeRole(siteInfra.humanDeployerRoleArn, "site-deployer")

  await syncStaticSiteToS3({
    sourceDir: "apps/marketing/dist/",
    bucket: siteInfra.bucket,
    deployRoleArn: siteInfra.deployRoleArn,
    deployerSession,
    dryRun: config.dryRun,
    sessionName: "deploy-marketing",
  })

  await invalidateStaticSiteCache({
    distributionId: siteInfra.distributionId,
    invalidationRoleArn: siteInfra.invalidationRoleArn,
    deployerSession,
    dryRun: config.dryRun,
    sessionName: "deploy-invalidation",
  })

  console.log("\n=== Deploy Complete ===")
  console.log(`Site: ${formatStaticSiteUrl(siteInfra.siteUrl)}`)
}

async function main(): Promise<void> {
  const config = await parseStaticSiteDeployArgs("deploy-marketing.ts")
  await deployMarketingSite(config)
}

if (isMain(import.meta)) {
  main().catch((err) => {
    console.error("Deploy failed:", err.message)
    process.exit(1)
  })
}
