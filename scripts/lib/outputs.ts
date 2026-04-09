/**
 * Fetch Yaffle terraform outputs for a workspace.
 *
 * Uses the yaffle CLI (`packages/cli/src/main.ts outputs`) to query
 * the control plane API for infrastructure outputs.
 */

import { $ } from "bun"

const YAFFLE_API_URL = process.env.YAFFLE_API_URL ?? "https://yaffle.local:6969"

interface TerraformOutput {
  value: unknown
  type?: string
  sensitive?: boolean
}

interface YaffleOutputsResponse {
  outputs: Record<string, TerraformOutput>
}

function getChildEnv(): Record<string, string> {
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value
    }
  }

  return env
}

async function getOrgRepo(): Promise<{ org: string; repo: string }> {
  const remote = await $`git remote get-url origin`.quiet().text()
  const match = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/)
  if (!match) {
    throw new Error("Could not determine org/repo from git remote")
  }
  return { org: match[1], repo: match[2] }
}

export interface FetchOutputsOptions {
  workspace: string
  environment?: string
  prNumber?: number
  wait?: boolean
  waitTimeout?: number
}

/**
 * Fetch terraform outputs for a workspace. Returns a flat key→value map.
 */
export async function fetchOutputs(opts: FetchOutputsOptions): Promise<Record<string, unknown>> {
  const args = [
    "--workspace", opts.workspace,
    "--format", "json",
  ]

  if (opts.prNumber) {
    args.push("--pr", String(opts.prNumber))
  } else if (opts.environment) {
    args.push("--env", opts.environment)
  } else {
    // Auto-detect from git branch
    const branch = await $`git rev-parse --abbrev-ref HEAD`.quiet().text()
    const trimmed = branch.trim()
    if (trimmed === "main" || trimmed === "master") {
      args.push("--env", trimmed)
    } else {
      throw new Error(`On branch '${trimmed}' — specify environment or prNumber`)
    }
  }

  if (opts.wait) {
    args.push("--wait")
    args.push("--timeout", String(opts.waitTimeout ?? 600))
  }

  console.log(`Fetching outputs for workspace=${opts.workspace}...`)

  const { org, repo } = await getOrgRepo()

  const proc = $`bun run packages/cli/src/main.ts outputs ${args}`
    .env({
      ...getChildEnv(),
      GITHUB_REPOSITORY: `${org}/${repo}`,
      YAFFLE_API_URL,
      NODE_TLS_REJECT_UNAUTHORIZED: YAFFLE_API_URL.includes("localhost") || YAFFLE_API_URL.includes(".local") ? "0" : "1",
    })
    .quiet()

  let output: string
  try {
    output = await proc.text()
  } catch (err: unknown) {
    console.error(`[error] yaffle-outputs failed:`)
    if (err && typeof err === "object" && "stderr" in err) {
      console.error(String((err as any).stderr))
    } else if (err instanceof Error) {
      console.error(err.message)
    }
    throw err
  }

  let result: YaffleOutputsResponse
  try {
    result = JSON.parse(output)
  } catch {
    console.error(`[error] Failed to parse yaffle-outputs response:`)
    console.error(output)
    throw new Error("Invalid JSON from yaffle-outputs")
  }

  if (!result.outputs) {
    throw new Error(`No outputs from Yaffle for ${opts.workspace}`)
  }

  const flat: Record<string, unknown> = {}
  for (const [key, out] of Object.entries(result.outputs)) {
    flat[key] = out.value
  }

  return flat
}
