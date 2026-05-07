/**
 * Fetch Yaffle terraform outputs for a workspace.
 *
 * Uses the shared Yaffle client package to query the control plane API for
 * infrastructure outputs.
 */

import { $ } from "bun"
import { execSync } from "node:child_process"

import {
  getCredentials,
  getHost,
  TokenAuth,
  type Target,
  type TerraformOutput,
  YaffleClient,
} from "../../packages/yaffle-client/src/index"

const DEFAULT_API_URL = "https://yaffle.dev"

function normalizeApiUrl(apiUrl: string): string {
  const trimmed = apiUrl.trim().replace(/\/+$/, "")

  if (!trimmed) {
    return trimmed
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed
  }

  return `https://${trimmed}`
}

function resolveApiUrl(): string {
  return normalizeApiUrl(process.env.YAFFLE_API_URL || DEFAULT_API_URL)
}

async function getOrgRepo(): Promise<{ org: string; repo: string }> {
  const remote = (await $`git remote get-url origin`.quiet().text()).trim()
  const match = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/)
  if (!match) {
    throw new Error("Could not determine org/repo from git remote")
  }
  return { org: match[1].trim(), repo: match[2].trim() }
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
  console.log(`Fetching outputs for workspace=${opts.workspace}...`)

  const { org, repo } = await getOrgRepo()
  const apiUrl = resolveApiUrl()

  const target = await resolveTarget(opts)
  const client = await createClient(apiUrl)

  let result: {
    previewId: string
    status: string
    outputs: Record<string, TerraformOutput> | null
  }

  try {
    result = await client.getOutputs({
      org,
      repo,
      target,
      workspace: opts.workspace,
      wait: opts.wait ?? false,
      waitTimeout: opts.waitTimeout ?? 600,
    })
  } catch (err) {
    if (err instanceof Error) {
      console.error(`[error] yaffle outputs failed:`)
      console.error(err.message)
    }
    throw err
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

async function resolveTarget(opts: FetchOutputsOptions): Promise<Target> {
  if (opts.prNumber) {
    return { type: "pr", prNumber: opts.prNumber }
  }

  if (opts.environment) {
    return { type: "env", name: opts.environment }
  }

  const environmentName = process.env.YAFFLE_ENVIRONMENT_NAME?.trim()
  if (environmentName) {
    return { type: "env", name: environmentName }
  }

  const branch = await $`git rev-parse --abbrev-ref HEAD`.quiet().text()
  const trimmed = branch.trim()
  if (trimmed === "main" || trimmed === "master") {
    return { type: "env", name: trimmed }
  }

  throw new Error(`On branch '${trimmed}' — specify environment or prNumber`)
}

async function createClient(apiUrl: string): Promise<YaffleClient> {
  let token = process.env.YAFFLE_TOKEN || process.env.YAFFLE_API_TOKEN || process.env.GITHUB_TOKEN || ""

  if (!token) {
    const stored = await getCredentials(getHost(apiUrl))
    token = stored?.accessToken || ""
  }

  if (!token) {
    try {
      token = execSync("gh auth token", {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim()
    } catch {
      // ignore
    }
  }

  if (!token) {
    throw new Error(
      "Not authenticated. Run 'yaffle cloud login' locally, or set YAFFLE_TOKEN in CI/workflows.",
    )
  }

  return new YaffleClient({
    apiUrl,
    auth: new TokenAuth(token),
    logger: {
      info: (msg) => console.error(`[info] ${msg}`),
      warn: (msg) => console.error(`[warn] ${msg}`),
      error: (msg) => console.error(`[error] ${msg}`),
    },
  })
}
