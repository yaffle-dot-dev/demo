/**
 * Fetch Yaffle terraform outputs for a workspace.
 *
 * Uses the shared Yaffle client package to query the control plane API for
 * infrastructure outputs.
 */

import { execSync } from "node:child_process"

import {
  getCredentials,
  getHost,
  TokenAuth,
  type Target,
  type TerraformOutput,
  YaffleClient,
  type OutputWaitCondition,
} from "../../packages/yaffle-client/src/index"
import { exec } from "./exec"

const DEFAULT_API_URL = "https://yaffle.dev"
const outputsCache = new Map<string, Promise<Record<string, unknown>>>()

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
  const remote = (
    await exec(["git", "remote", "get-url", "origin"], {
      quiet: true,
    })
  ).trim()
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
  waitFor?: OutputWaitCondition
  waitTimeout?: number
}

/**
 * Fetch terraform outputs for a workspace. Returns a flat key→value map.
 */
export async function fetchOutputs(opts: FetchOutputsOptions): Promise<Record<string, unknown>> {
  const target = await resolveTarget(opts)
  const cacheKey = JSON.stringify({
    workspace: opts.workspace,
    target,
    waitFor: opts.waitFor,
    waitTimeout: opts.waitTimeout ?? 600,
  })

  const existing = outputsCache.get(cacheKey)
  if (existing) {
    return existing
  }

  const pending = (async () => {
    console.log(`Fetching outputs for workspace=${opts.workspace}...`)

    const { org, repo } = await getOrgRepo()
    const apiUrl = resolveApiUrl()
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
        waitFor: opts.waitFor,
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
      if (out.sensitive === true) {
        throw new Error(
          `Yaffle redacted sensitive output ${opts.workspace}.${key}; export a secret reference instead`,
        )
      }
      flat[key] = out.value
    }

    return flat
  })()

  outputsCache.set(cacheKey, pending)

  try {
    return await pending
  } catch (error) {
    outputsCache.delete(cacheKey)
    throw error
  }
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

  const branch = await exec(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
    quiet: true,
  })
  const trimmed = branch.trim()
  if (trimmed === "main" || trimmed === "master") {
    return { type: "env", name: trimmed }
  }

  throw new Error(`On branch '${trimmed}' — specify environment or prNumber`)
}

async function createClient(apiUrl: string): Promise<YaffleClient> {
  let token =
    process.env.YAFFLE_TOKEN || process.env.YAFFLE_API_TOKEN || process.env.GITHUB_TOKEN || ""

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
