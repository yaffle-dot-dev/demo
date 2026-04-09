import { $ } from "bun"
import { parseArgs } from "node:util"

import { assumeRole } from "./aws-auth"
import { fetchOutputs } from "./outputs"

export type DeployTarget =
  | { type: "pr"; prNumber: number }
  | { type: "env"; name: string }

export interface DeployConfig {
  target: DeployTarget
  wait: boolean
  skipBuild: boolean
  dryRun: boolean
}

export interface StaticSiteInfrastructure {
  bucket: string
  deployRoleArn: string
  humanDeployerRoleArn: string
  siteUrl: string
  distributionId: string
  invalidationRoleArn: string
}

interface LoadStaticSiteInfrastructureOptions {
  siteWorkspace: string
  humanDeployerRoleOutput: string
  target: DeployTarget
  wait: boolean
  frontendWorkspace?: string
}

interface SyncStaticSiteToS3Options {
  sourceDir: string
  bucket: string
  deployRoleArn: string
  deployerSession?: Record<string, string>
  dryRun: boolean
  sessionName: string
  s3Prefix?: string
}

interface InvalidateStaticSiteCacheOptions {
  distributionId: string
  invalidationRoleArn: string
  deployerSession?: Record<string, string>
  dryRun: boolean
  sessionName: string
  s3Prefix?: string
}

interface RunStaticSiteBuildOptions {
  appDir: string
  appLabel: string
  dryRun: boolean
  env?: Record<string, string>
}

function parsePrNumber(value: string): number {
  const prNumber = Number.parseInt(value, 10)

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid PR number: ${value}`)
  }

  return prNumber
}

function getRequiredOutput(
  outputs: Record<string, unknown>,
  key: string,
  workspace: string,
): string {
  const value = outputs[key]

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${workspace} must export ${key}`)
  }

  return value
}

async function getCurrentBranch(): Promise<string> {
  const branch = await $`git rev-parse --abbrev-ref HEAD`.text()
  return branch.trim()
}

export async function loadOutputsForTarget(
  workspace: string,
  target: DeployTarget,
  wait: boolean,
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

function getS3Destination(bucket: string, s3Prefix?: string): string {
  return s3Prefix ? `s3://${bucket}/${s3Prefix}` : `s3://${bucket}`
}

export function formatDeployTarget(target: DeployTarget): string {
  return target.type === "pr" ? `PR #${target.prNumber}` : `env: ${target.name}`
}

export function formatStaticSiteUrl(siteUrl: string, s3Prefix?: string): string {
  const normalizedSiteUrl = siteUrl.endsWith("/") ? siteUrl.slice(0, -1) : siteUrl
  return s3Prefix ? `${normalizedSiteUrl}/${s3Prefix}/` : normalizedSiteUrl
}

export async function runStaticSiteBuild(options: RunStaticSiteBuildOptions): Promise<void> {
  console.log(`\nBuilding ${options.appLabel} site...`)

  if (options.dryRun) {
    console.log(`[dry-run] Would run: bun run build (cwd: ${options.appDir})`)
    return
  }

  const command = $`bun run build`.cwd(options.appDir)

  if (options.env) {
    await command.env(options.env)
    return
  }

  await command
}

export async function parseStaticSiteDeployArgs(scriptName: string): Promise<DeployConfig> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      pr: { type: "string" },
      env: { type: "string" },
      "no-wait": { type: "boolean", default: false },
      "skip-build": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  })

  if (values.help) {
    console.log(`
Usage: ${scriptName} [options]

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
    target = { type: "pr", prNumber: parsePrNumber(values.pr) }
  } else if (values.env) {
    target = { type: "env", name: values.env }
  } else {
    const branch = await getCurrentBranch()

    if (branch === "main" || branch === "master") {
      target = { type: "env", name: branch }
    } else {
      throw new Error(
        `On branch '${branch}'. Specify --pr <number> or --env <name> (only main/master auto-deploy without flags)`,
      )
    }
  }

  return {
    target,
    wait: !values["no-wait"],
    skipBuild: values["skip-build"] ?? false,
    dryRun: values["dry-run"] ?? false,
  }
}

export async function loadStaticSiteInfrastructure(
  options: LoadStaticSiteInfrastructureOptions,
): Promise<StaticSiteInfrastructure> {
  const frontendWorkspace = options.frontendWorkspace ?? "apps/infra"
  const [siteOutputs, frontendOutputs] = await Promise.all([
    loadOutputsForTarget(options.siteWorkspace, options.target, options.wait),
    loadOutputsForTarget(frontendWorkspace, options.target, options.wait),
  ])

  return {
    bucket: getRequiredOutput(siteOutputs, "primary_bucket_name", options.siteWorkspace),
    deployRoleArn: getRequiredOutput(siteOutputs, "deploy_role_arn", options.siteWorkspace),
    humanDeployerRoleArn: getRequiredOutput(
      siteOutputs,
      options.humanDeployerRoleOutput,
      options.siteWorkspace,
    ),
    siteUrl: getRequiredOutput(frontendOutputs, "site_url", frontendWorkspace),
    distributionId: getRequiredOutput(
      frontendOutputs,
      "cloudfront_distribution_id",
      frontendWorkspace,
    ),
    invalidationRoleArn: getRequiredOutput(
      frontendOutputs,
      "invalidation_role_arn",
      frontendWorkspace,
    ),
  }
}

export async function syncStaticSiteToS3(options: SyncStaticSiteToS3Options): Promise<void> {
  const destination = getS3Destination(options.bucket, options.s3Prefix)

  console.log(`\nSyncing to S3 destination: ${destination}...`)

  if (options.dryRun) {
    console.log(`[dry-run] Would sync ${options.sourceDir} to ${destination}`)
    return
  }

  const creds = await assumeRole(options.deployRoleArn, options.sessionName, options.deployerSession)

  await $`aws s3 sync ${options.sourceDir} ${destination} \
    --delete \
    --cache-control "public, max-age=31536000, immutable" \
    --exclude "*" \
    --include "_astro/*"`.env(creds)

  await $`aws s3 sync ${options.sourceDir} ${destination} \
    --delete \
    --cache-control "public, max-age=0, must-revalidate" \
    --exclude "_astro/*"`.env(creds)
}

export async function invalidateStaticSiteCache(
  options: InvalidateStaticSiteCacheOptions,
): Promise<void> {
  const invalidationPath = options.s3Prefix ? `/${options.s3Prefix}/*` : "/*"

  console.log(`\nInvalidating CloudFront distribution: ${options.distributionId}...`)

  if (options.dryRun) {
    console.log(`[dry-run] Would invalidate CloudFront path: ${invalidationPath}`)
    return
  }

  const creds = await assumeRole(
    options.invalidationRoleArn,
    options.sessionName,
    options.deployerSession,
  )

  await $`aws cloudfront create-invalidation \
    --distribution-id ${options.distributionId} \
    --paths ${invalidationPath}`.env(creds)
}
