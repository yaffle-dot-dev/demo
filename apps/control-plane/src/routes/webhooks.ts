import { Hono } from "hono"

import type {
  PullRequestAction,
  PullRequestContext,
  PushContext,
} from "@yaffle/shared"

import { getEnv } from "../lib/env.ts"
import { logger, getWebhookReceivedCounter } from "../lib/telemetry.ts"
import { verifyWebhookSignature } from "../lib/webhook-verify.ts"
import { handleWebhookEvent } from "../lib/webhook-handler.ts"
import {
  ensureOrg,
  updateOrgInstallationStatus,
  findOrgByInstallationId,
} from "../db/queries/organizations.ts"
import {
  ensureRepo,
  deactivateRepos,
  deactivateAllReposForOrg,
  reactivateRepos,
} from "../db/queries/repositories.ts"
import { ensureUser, ensureMembership } from "../db/queries/users.ts"

export const webhooksRoute = new Hono()

const SUPPORTED_PR_ACTIONS: PullRequestAction[] = [
  "opened",
  "synchronize",
  "closed",
  "reopened",
]

// Simple in-memory deduplication for webhook deliveries
// Prevents duplicate processing if GitHub retries or sends twice
const recentDeliveries = new Set<string>()
const DELIVERY_TTL_MS = 60_000 // Keep delivery IDs for 1 minute

function markDeliveryProcessed(deliveryId: string): boolean {
  if (recentDeliveries.has(deliveryId)) {
    return false // Already processed
  }
  recentDeliveries.add(deliveryId)
  setTimeout(() => recentDeliveries.delete(deliveryId), DELIVERY_TTL_MS)
  return true // First time seeing this
}

// Deduplicate PR events by repo+pr+action+sha (GitHub sometimes sends duplicates with different delivery IDs)
const recentPrEvents = new Set<string>()

function markPrEventProcessed(repo: string, prNumber: number, action: string, sha: string): boolean {
  const key = `${repo}:${prNumber}:${action}:${sha}`
  if (recentPrEvents.has(key)) {
    return false // Already processed this exact event
  }
  recentPrEvents.add(key)
  setTimeout(() => recentPrEvents.delete(key), DELIVERY_TTL_MS)
  return true
}

webhooksRoute.post("/github", async (c) => {
  const event = c.req.header("x-github-event")
  const signature = c.req.header("x-hub-signature-256")
  const deliveryId = c.req.header("x-github-delivery")

  const body = await c.req.text()

  // Verify signature
  try {
    const env = getEnv()
    await verifyWebhookSignature(body, signature, env.githubWebhookSecret)
  } catch (err) {
    logger.error("webhook verification failed", {
      "error": err instanceof Error ? err.message : String(err),
    })
    return c.json(
      { error: { code: "WEBHOOK_VERIFICATION_FAILED", message: "invalid signature" } },
      401,
    )
  }

  // Deduplicate webhook deliveries
  if (deliveryId && !markDeliveryProcessed(deliveryId)) {
    logger.info(`duplicate webhook delivery ignored: ${deliveryId}`, {
      "webhook.event": event ?? "unknown",
      "webhook.delivery_id": deliveryId,
    })
    return c.json({ data: { ignored: true, reason: "duplicate delivery" } })
  }

  getWebhookReceivedCounter().add(1, { event: event ?? "unknown" })
  console.log(`[webhook] RECEIVED: event=${event} delivery=${deliveryId}`)
  logger.info(`webhook received: event=${event} delivery=${deliveryId}`, {
    "webhook.event": event ?? "unknown",
    "webhook.delivery_id": deliveryId ?? "unknown",
  })

  const payload = JSON.parse(body)

  if (event === "pull_request") {
    const action = payload.action as string
    const prNumber = payload.pull_request?.number as number
    const headSha = payload.pull_request?.head?.sha as string
    const repoName = payload.repository?.name as string
    console.log(`[webhook] PR event: action=${action} pr=${prNumber} sha=${headSha}`)

    if (!SUPPORTED_PR_ACTIONS.includes(action as PullRequestAction)) {
      return c.json({ data: { ignored: true, reason: `unhandled PR action: ${action}` } })
    }

    // Deduplicate by repo+pr+action+sha (GitHub sometimes sends duplicate webhooks)
    if (!markPrEventProcessed(repoName, prNumber, action, headSha)) {
      console.log(`[webhook] duplicate PR event ignored: ${repoName}#${prNumber} ${action} ${headSha}`)
      return c.json({ data: { ignored: true, reason: "duplicate PR event" } })
    }

    const context: PullRequestContext = {
      kind: "pull_request",
      installationId: payload.installation?.id,
      ownerGithubId: payload.repository.owner.id,
      owner: payload.repository.owner.login,
      repo: repoName,
      prNumber,
      action: action as PullRequestAction,
      headSha,
      branch: payload.pull_request.head.ref,
      authorGithubId: payload.pull_request.user?.id ?? 0,
      authorLogin: payload.pull_request.user?.login ?? "unknown",
      merged: payload.pull_request.merged ?? false,
      defaultBranch: payload.repository.default_branch,
    }

    handleWebhookEvent(context).catch((err) => {
      logger.error(`error handling PR event for ${context.owner}/${context.repo}#${context.prNumber}`, {
        "yaffle.owner": context.owner,
        "yaffle.repo": context.repo,
        "yaffle.pr_number": context.prNumber,
        "error": err instanceof Error ? err.message : String(err),
      })
    })

    return c.json({ data: { received: true } })
  }

  if (event === "push") {
    // Extract the branch name from refs/heads/...
    const ref = payload.ref as string
    if (!ref.startsWith("refs/heads/")) {
      return c.json({ data: { ignored: true, reason: `non-branch push: ${ref}` } })
    }

    const branch = ref.replace("refs/heads/", "")

    // Log both `after` and `head_commit.id` to diagnose SHA discrepancies
    const afterSha = payload.after as string
    const headCommitSha = payload.head_commit?.id as string | undefined
    const beforeSha = payload.before as string
    console.log(`[webhook] push event: branch=${branch} after=${afterSha} head_commit=${headCommitSha} before=${beforeSha}`)
    logger.info(`push webhook received`, {
      "webhook.branch": branch,
      "webhook.after": afterSha,
      "webhook.head_commit_id": headCommitSha ?? "none",
      "webhook.before": beforeSha,
      "webhook.sha_match": afterSha === headCommitSha,
    })

    // Ignore branch deletion events (after SHA is all zeros)
    const nullSha = "0000000000000000000000000000000000000000"
    if (!afterSha || afterSha === nullSha) {
      return c.json({ data: { ignored: true, reason: "branch deletion push (no head SHA)" } })
    }

    const context: PushContext = {
      kind: "push",
      installationId: payload.installation?.id,
      ownerGithubId: payload.repository.owner.id,
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      headSha: payload.after,
      branch,
      pusherGithubId: payload.sender?.id ?? null,
      pusherLogin: payload.sender?.login ?? null,
      defaultBranch: payload.repository.default_branch,
    }

    handleWebhookEvent(context).catch((err) => {
      logger.error(`error handling push event for ${context.owner}/${context.repo}@${context.branch}`, {
        "yaffle.owner": context.owner,
        "yaffle.repo": context.repo,
        "yaffle.branch": context.branch,
        "error": err instanceof Error ? err.message : String(err),
      })
    })

    return c.json({ data: { received: true } })
  }

  // Handle GitHub App installation events
  if (event === "installation") {
    const action = payload.action as string
    const installation = payload.installation
    const account = installation?.account

    if (!installation || !account) {
      return c.json({ data: { ignored: true, reason: "missing installation data" } })
    }

    const installationId = installation.id as number
    const githubId = account.id as number
    const login = account.login as string

    logger.info(`installation event: action=${action} org=${login}`, {
      "webhook.action": action,
      "yaffle.org": login,
      "yaffle.installation_id": installationId,
    })

    if (action === "created") {
      // App was installed - create/update org and track repos
      const org = await ensureOrg(login, githubId, installationId)

      // Track initial repositories
      const repositories = payload.repositories ?? []
      for (const repo of repositories) {
        await ensureRepo({
          orgId: org.id,
          githubId: repo.id,
          name: repo.name,
          fullName: repo.full_name,
        })
      }

      // Create membership for the user who installed the app
      const sender = payload.sender
      if (sender?.id && sender?.login) {
        const user = await ensureUser({
          login: sender.login,
          provider: "github",
          externalId: String(sender.id),
        })
        await ensureMembership({
          orgId: org.id,
          userId: user.id,
          role: "admin", // installer gets admin
          source: "admin_bootstrap",
        })
        logger.info(`created admin membership for installer: user=${sender.login} org=${login}`, {
          "yaffle.org": login,
          "yaffle.user": sender.login,
        })
      }

      logger.info(`installation created: org=${login} repos=${repositories.length}`, {
        "yaffle.org": login,
        "yaffle.repo_count": repositories.length,
      })

      return c.json({ data: { received: true, action: "installation_created" } })
    }

    if (action === "deleted") {
      // App was uninstalled - mark org as uninstalled and deactivate all repos
      const org = await findOrgByInstallationId(installationId)
      if (org) {
        await updateOrgInstallationStatus(githubId, "uninstalled")
        await deactivateAllReposForOrg(org.id)
      }

      logger.info(`installation deleted: org=${login}`, { "yaffle.org": login })

      return c.json({ data: { received: true, action: "installation_deleted" } })
    }

    if (action === "suspend") {
      // App was suspended - mark org as suspended
      await updateOrgInstallationStatus(githubId, "suspended")
      logger.info(`installation suspended: org=${login}`, { "yaffle.org": login })
      return c.json({ data: { received: true, action: "installation_suspended" } })
    }

    if (action === "unsuspend") {
      // App was unsuspended - mark org as active again
      await updateOrgInstallationStatus(githubId, "active")
      logger.info(`installation unsuspended: org=${login}`, { "yaffle.org": login })
      return c.json({ data: { received: true, action: "installation_unsuspended" } })
    }

    return c.json({ data: { ignored: true, reason: `unhandled installation action: ${action}` } })
  }

  // Handle repository access changes
  if (event === "installation_repositories") {
    const action = payload.action as string
    const installation = payload.installation
    const account = installation?.account

    if (!installation || !account) {
      return c.json({ data: { ignored: true, reason: "missing installation data" } })
    }

    const installationId = installation.id as number
    const login = account.login as string

    const org = await findOrgByInstallationId(installationId)
    if (!org) {
      logger.warn(`installation_repositories event for unknown installation: ${installationId}`)
      return c.json({ data: { ignored: true, reason: "unknown installation" } })
    }

    if (action === "added") {
      const addedRepos = payload.repositories_added ?? []
      for (const repo of addedRepos) {
        await ensureRepo({
          orgId: org.id,
          githubId: repo.id,
          name: repo.name,
          fullName: repo.full_name,
        })
      }
      // Reactivate any that were previously removed
      await reactivateRepos(addedRepos.map((r: { id: number }) => r.id))

      logger.info(`repos added to installation: org=${login} count=${addedRepos.length}`, {
        "yaffle.org": login,
        "yaffle.repo_count": addedRepos.length,
      })

      return c.json({ data: { received: true, action: "repos_added" } })
    }

    if (action === "removed") {
      const removedRepos = payload.repositories_removed ?? []
      await deactivateRepos(removedRepos.map((r: { id: number }) => r.id))

      logger.info(`repos removed from installation: org=${login} count=${removedRepos.length}`, {
        "yaffle.org": login,
        "yaffle.repo_count": removedRepos.length,
      })

      return c.json({ data: { received: true, action: "repos_removed" } })
    }

    return c.json({ data: { ignored: true, reason: `unhandled installation_repositories action: ${action}` } })
  }

  return c.json({ data: { ignored: true, reason: `unhandled event: ${event}` } })
})
