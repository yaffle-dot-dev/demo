import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager"
import { App } from "octokit"

const YAFFLE_MONOREPO_OWNER = process.env.YAFFLE_MONOREPO_OWNER?.trim() || "yaffle-dot-dev"
const YAFFLE_MONOREPO_REPO = process.env.YAFFLE_MONOREPO_REPO?.trim() || "yaffle"

const secretsClient = new SecretsManagerClient({})
let cachedAppPromise: Promise<App> | undefined

export function normalizePem(value: string): string {
  const escapedNewlines = value.replace(/\\n/g, "\n").trim()

  if (escapedNewlines.includes("\n")) {
    return escapedNewlines
  }

  const match = escapedNewlines.match(
    /^(-----BEGIN [A-Z ]+-----)\s+(.+?)\s+(-----END [A-Z ]+-----)-*$/,
  )

  if (!match) {
    return escapedNewlines
  }

  const [, header, body, footer] = match
  const bodyNoSpaces = body.replace(/\s+/g, "")
  const lines: string[] = []
  for (let i = 0; i < bodyNoSpaces.length; i += 64) {
    lines.push(bodyNoSpaces.slice(i, i + 64))
  }

  return `${header}\n${lines.join("\n")}\n${footer}`
}

async function getSecretString(secretIdEnv: string): Promise<string> {
  const secretId = process.env[secretIdEnv]?.trim()
  if (!secretId) {
    throw new Error(`${secretIdEnv} must be configured`)
  }

  const secret = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretId }))
  if (!secret.SecretString?.trim()) {
    throw new Error(`Secrets Manager secret '${secretId}' did not contain SecretString`)
  }

  return secret.SecretString.trim()
}

async function getApp(): Promise<App> {
  cachedAppPromise ??= (async () => {
    const [appId, rawPrivateKey] = await Promise.all([
      getSecretString("GITHUB_APP_ID_SECRET_ARN"),
      getSecretString("GITHUB_APP_PRIVATE_KEY_SECRET_ARN"),
    ])

    const privateKey = normalizePem(rawPrivateKey)

    return new App({
      appId,
      privateKey,
    })
  })()

  return cachedAppPromise
}

export interface GithubPolicyClient {
  assertMonorepoWriteAccess(actorLogin: string): Promise<void>
  assertPullRequestOpen(prNumber: number): Promise<void>
  assertPersonalScopeOwnership(params: {
    actorGithubUserId: number
    actorGithubLogin: string
    installationId: number
    repositoryId?: number
  }): Promise<{
    githubOwnerType: string
    githubOwnerId: number
    githubOwnerLogin: string
  }>
}

class OctokitGithubPolicyClient implements GithubPolicyClient {
  async assertMonorepoWriteAccess(actorLogin: string): Promise<void> {
    const app = await getApp()
    const installation = await app.octokit.request("GET /repos/{owner}/{repo}/installation", {
      owner: YAFFLE_MONOREPO_OWNER,
      repo: YAFFLE_MONOREPO_REPO,
    })
    const octokit = await app.getInstallationOctokit(installation.data.id)

    try {
      const response = await octokit.request("GET /repos/{owner}/{repo}/collaborators/{username}/permission", {
        owner: YAFFLE_MONOREPO_OWNER,
        repo: YAFFLE_MONOREPO_REPO,
        username: actorLogin,
      })

      const permission = (response.data as { permission?: string }).permission
      if (!permission || !["admin", "maintain", "write"].includes(permission)) {
        throw new Error("YAFFLE_MONOREPO_WRITE_REQUIRED")
      }
    } catch (error) {
      const status = (error as { status?: number }).status
      if (status === 404) {
        throw new Error("YAFFLE_MONOREPO_WRITE_REQUIRED")
      }
      throw error
    }
  }

  async assertPullRequestOpen(prNumber: number): Promise<void> {
    const app = await getApp()
    const installation = await app.octokit.request("GET /repos/{owner}/{repo}/installation", {
      owner: YAFFLE_MONOREPO_OWNER,
      repo: YAFFLE_MONOREPO_REPO,
    })
    const octokit = await app.getInstallationOctokit(installation.data.id)

    const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: YAFFLE_MONOREPO_OWNER,
      repo: YAFFLE_MONOREPO_REPO,
      pull_number: prNumber,
    })

    if ((response.data as { state?: string }).state !== "open") {
      throw new Error("PREVIEW_PR_NOT_OPEN")
    }
  }

  async assertPersonalScopeOwnership(params: {
    actorGithubUserId: number
    actorGithubLogin: string
    installationId: number
    repositoryId?: number
  }): Promise<{
    githubOwnerType: string
    githubOwnerId: number
    githubOwnerLogin: string
  }> {
    const app = await getApp()
    const installationResponse = await app.octokit.request("GET /app/installations/{installation_id}", {
      installation_id: params.installationId,
    })

    const account = (installationResponse.data as {
      account?: { id?: number; login?: string; type?: string }
    }).account

    if (!account?.id || !account.login || account.type !== "User") {
      throw new Error("PERSONAL_SCOPE_REQUIRED")
    }

    if (account.id !== params.actorGithubUserId || account.login !== params.actorGithubLogin) {
      throw new Error("PERSONAL_SCOPE_REQUIRED")
    }

    if (params.repositoryId == null) {
      return {
        githubOwnerType: account.type.toLowerCase(),
        githubOwnerId: account.id,
        githubOwnerLogin: account.login,
      }
    }

    const octokit = await app.getInstallationOctokit(params.installationId)

    try {
      const repositoryResponse = await octokit.request("GET /repositories/{repository_id}", {
        repository_id: params.repositoryId,
      })
      const owner = (repositoryResponse.data as {
        owner?: { id?: number; login?: string; type?: string }
      }).owner

      if (!owner?.id || !owner.login || owner.type !== "User") {
        throw new Error("PERSONAL_SCOPE_REQUIRED")
      }

      if (owner.id !== params.actorGithubUserId || owner.login !== params.actorGithubLogin) {
        throw new Error("PERSONAL_SCOPE_REQUIRED")
      }

      return {
        githubOwnerType: owner.type.toLowerCase(),
        githubOwnerId: owner.id,
        githubOwnerLogin: owner.login,
      }
    } catch (error) {
      const status = (error as { status?: number }).status
      if (status === 404) {
        throw new Error("REPOSITORY_NOT_ACCESSIBLE")
      }
      throw error
    }
  }
}

export function createGithubPolicyClient(): GithubPolicyClient {
  return new OctokitGithubPolicyClient()
}
