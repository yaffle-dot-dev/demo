/**
 * Shared CI/CD configuration derived from environment variables and git.
 */

import { exec } from "./exec"

export interface Config {
  region: string
  registry: string
  tier: string
  sha: string
  shouldPush: boolean
  dryRun: boolean
}

let _config: Config | null = null

export async function getConfig(): Promise<Config> {
  if (_config) return _config

  const region = process.env.AWS_REGION ?? "us-east-1"
  const registry = process.env.YAFFLE_REGISTRY ?? "870923192739.dkr.ecr.us-east-1.amazonaws.com"
  const environmentName = process.env.YAFFLE_ENVIRONMENT_NAME?.trim()
  const environmentKind = process.env.YAFFLE_ENVIRONMENT_KIND?.trim()

  const sha = process.env.YAFFLE_SHA
    ?? (await exec(["git", "rev-parse", "HEAD"], { quiet: true })).trim()

  const branch = process.env.YAFFLE_BRANCH
    ?? (await exec(["git", "rev-parse", "--abbrev-ref", "HEAD"], { quiet: true })).trim()

  const tier = process.env.YAFFLE_TIER
    ?? ((environmentKind === "named" && environmentName === "main") || branch === "main"
      ? "production"
      : "nonprod")
  // Only push by default on main. Locally on feature branches, build-only unless explicitly told to push.
  const shouldPush = process.env.YAFFLE_PUSH === "true" || (process.env.YAFFLE_PUSH !== "false" && branch === "main")
  const dryRun = process.env.YAFFLE_DRY_RUN === "true"

  _config = { region, registry, tier, sha, shouldPush, dryRun }
  return _config
}

export function imageUri(registry: string, service: string, tier: string): string {
  return `${registry}/yaffle-${service}-${tier}`
}

/** Name suffix used in ECS resource names (e.g., "main-use1") */
export function nameSuffix(tier: string, region: string): string {
  // "us-east-1" → "use1"
  const parts = region.split("-")
  const short = parts[0] + parts[1][0] + parts[2]
  return tier === "production" ? `main-${short}` : `nonprod-${short}`
}
