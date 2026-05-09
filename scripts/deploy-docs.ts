#!/usr/bin/env node
/**
 * Deploy docs site to S3/CloudFront.
 */

import { assumeRole } from "./lib/aws-auth"
import { importMetaDir, isMain } from "./lib/module"
import {
  type DeployConfig,
  formatDeployTarget,
  formatStaticSiteUrl,
  invalidateStaticSiteCache,
  loadStaticSiteInfrastructure,
  parseStaticSiteDeployArgs,
  runStaticSiteBuild,
  syncStaticSiteToS3,
} from "./lib/static-site-deploy"

const DOCS_DIR = `${importMetaDir(import.meta)}/../apps/docs`
const DOCS_PREFIX = "docs"

export async function buildDocsSite(dryRun: boolean): Promise<void> {
  await runStaticSiteBuild({
    appDir: DOCS_DIR,
    appLabel: "docs",
    dryRun,
  })
}

export async function deployDocsSite(config: DeployConfig): Promise<void> {
  const targetLabel = formatDeployTarget(config.target)

  console.log("=== Docs Site Deploy ===")
  console.log(`Target: ${targetLabel}`)
  if (config.dryRun) console.log("(dry-run mode)")

  const siteInfra = await loadStaticSiteInfrastructure({
    siteWorkspace: "apps/docs/infra",
    humanDeployerRoleOutput: "docs_deployer_role_arn",
    target: config.target,
    wait: config.wait,
  })

  console.log("\nInfrastructure:")
  console.log(`  Bucket: ${siteInfra.bucket}`)
  console.log(`  Site URL: ${formatStaticSiteUrl(siteInfra.siteUrl, DOCS_PREFIX)}`)
  console.log(`  CloudFront: ${siteInfra.distributionId}`)

  if (!config.skipBuild) {
    await buildDocsSite(config.dryRun)
  } else {
    console.log("\nSkipping build (--skip-build)")
  }

  const deployerSession = config.dryRun
    ? undefined
    : await assumeRole(siteInfra.humanDeployerRoleArn, "docs-deployer")

  await syncStaticSiteToS3({
    sourceDir: "apps/docs/dist/",
    bucket: siteInfra.bucket,
    deployRoleArn: siteInfra.deployRoleArn,
    deployerSession,
    dryRun: config.dryRun,
    sessionName: "deploy-docs",
    s3Prefix: DOCS_PREFIX,
  })

  await invalidateStaticSiteCache({
    distributionId: siteInfra.distributionId,
    invalidationRoleArn: siteInfra.invalidationRoleArn,
    deployerSession,
    dryRun: config.dryRun,
    sessionName: "deploy-invalidation",
    s3Prefix: DOCS_PREFIX,
  })

  console.log("\n=== Deploy Complete ===")
  console.log(`Site: ${formatStaticSiteUrl(siteInfra.siteUrl, DOCS_PREFIX)}`)
}

async function main(): Promise<void> {
  const config = await parseStaticSiteDeployArgs("deploy-docs.ts")
  await deployDocsSite(config)
}

if (isMain(import.meta)) {
  main().catch((err) => {
    console.error("Deploy failed:", err.message)
    process.exit(1)
  })
}
