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
/**
 * Fetch a single file's contents from a repo at a specific ref.
 * Returns the decoded content, or undefined if the file doesn't exist.
 */
export async function fetchFileContent(
  installationId: number,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | undefined> {
  const octokit = await getInstallationOctokit(installationId)

  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path,
      ref,
    })

    const data = response.data as { content?: string; encoding?: string }
    if (data.content && data.encoding === "base64") {
      return Buffer.from(data.content, "base64").toString("utf-8")
    }
    return undefined
  } catch (err: unknown) {
    const status = (err as { status?: number }).status
    if (status === 404) return undefined
    throw err
  }
}

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

/**
 * Upsert a PR comment. Finds an existing comment by a hidden HTML marker,
 * then updates it or creates a new one.
 *
 * The marker is a comment like `<!-- yaffle:outputs:infra -->` embedded in the body.
 * This prevents duplicate comments on re-apply.
 */
export async function upsertPrComment(
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  marker: string,
): Promise<number> {
  const octokit = await getInstallationOctokit(installationId)

  // Find existing comment with this marker
  const existingId = await findCommentByMarker(
    octokit,
    owner,
    repo,
    prNumber,
    marker,
  )

  if (existingId) {
    await octokit.request(
      "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
      {
        owner,
        repo,
        comment_id: existingId,
        body,
      },
    )
    return existingId
  }

  const response = await octokit.request(
    "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    {
      owner,
      repo,
      issue_number: prNumber,
      body,
    },
  )
  return response.data.id
}

/**
 * Search PR comments for one containing a specific marker string.
 * Paginates through all comments to find it.
 */
async function findCommentByMarker(
  octokit: Awaited<ReturnType<App["getInstallationOctokit"]>>,
  owner: string,
  repo: string,
  prNumber: number,
  marker: string,
): Promise<number | undefined> {
  let page = 1
  const perPage = 100

  while (true) {
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner,
        repo,
        issue_number: prNumber,
        per_page: perPage,
        page,
      },
    )

    const comments = response.data as Array<{ id: number; body?: string }>

    for (const comment of comments) {
      if (comment.body?.includes(marker)) {
        return comment.id
      }
    }

    if (comments.length < perPage) break
    page++
  }

  return undefined
}
