import { App } from "octokit"

import { GitHubAuthError } from "@yaffle/shared"

import { getEnv } from "./env.ts"

let appInstance: App | null = null

/**
 * Get or create the Octokit App instance.
 * Authenticates as the GitHub App using the private key.
 */
export function getApp(): App {
  if (appInstance) return appInstance

  const env = getEnv()
  if (!env.githubAppId || !env.githubAppPrivateKey) {
    throw new GitHubAuthError(
      "GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set",
    )
  }

  appInstance = new App({
    appId: env.githubAppId,
    privateKey: env.githubAppPrivateKey,
  })

  return appInstance
}

/**
 * Get an authenticated Octokit instance for a specific installation.
 */
export async function getInstallationOctokit(installationId: number): ReturnType<App["getInstallationOctokit"]> {
  const app = getApp()
  return app.getInstallationOctokit(installationId)
}

/**
 * Get an installation access token for git clone authentication.
 * This token can be used as: https://x-access-token:{token}@github.com/...
 */
export async function getInstallationToken(installationId: number): Promise<string> {
  const octokit = await getInstallationOctokit(installationId)
  // The octokit instance already has the token from auth, extract it
  const auth = (await octokit.auth({ type: "installation" })) as { token: string }
  return auth.token
}

export interface CheckRunParams {
  owner: string
  repo: string
  headSha: string
  name: string
  status: "queued" | "in_progress" | "completed"
  conclusion?: "success" | "failure" | "cancelled" | "action_required"
  title: string
  summary: string
  text?: string
}

/**
 * Create a GitHub Check Run on a commit.
 */
export async function createCheckRun(
  installationId: number,
  params: CheckRunParams,
): Promise<number> {
  const octokit = await getInstallationOctokit(installationId)

  const response = await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
    owner: params.owner,
    repo: params.repo,
    name: params.name,
    head_sha: params.headSha,
    status: params.status,
    conclusion: params.conclusion,
    output: {
      title: params.title,
      summary: params.summary,
      text: params.text,
    },
  })

  return response.data.id
}

/**
 * Update an existing GitHub Check Run.
 */
export async function updateCheckRun(
  installationId: number,
  owner: string,
  repo: string,
  checkRunId: number,
  params: Partial<Omit<CheckRunParams, "owner" | "repo" | "headSha">>,
): Promise<void> {
  const octokit = await getInstallationOctokit(installationId)

  await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
    owner,
    repo,
    check_run_id: checkRunId,
    status: params.status,
    conclusion: params.conclusion,
    output: params.title
      ? {
          title: params.title,
          summary: params.summary ?? "",
          text: params.text,
        }
      : undefined,
  })
}
