/**
 * Fetch Yaffle terraform outputs for a workspace.
 *
 * Uses the yaffle-outputs CLI (packages/cli/src/outputs.ts) to query
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

async function getToken(): Promise<string> {
  const envToken = process.env.YAFFLE_TOKEN || process.env.GITHUB_TOKEN || process.env.YAFFLE_API_TOKEN
  if (envToken) return envToken

  try {
    const token = await $`gh auth token`.quiet().text()
    return token.trim()
  } catch {
    throw new Error(
      "No auth token found. Set GITHUB_TOKEN, YAFFLE_TOKEN, or run 'gh auth login'"
    )
  }
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
  const token = await getToken()

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

  const proc = $`bun run ${import.meta.dir}/../../packages/cli/src/outputs.ts ${args}`
    .env({
      GITHUB_TOKEN: token,
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
