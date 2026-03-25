import { Hono } from "hono"
import { SpanKind } from "@opentelemetry/api"

import type {
  PullRequestAction,
  PullRequestContext,
  PushContext,
  RefType,
} from "@yaffle/shared"

import { getEnv } from "../lib/env.ts"
import {
  enforceRateLimit,
  readRequestBodyText,
  RequestBodyTooLargeError,
} from "../lib/request-protection.ts"
import { logger, getWebhookReceivedCounter, withSpan, SpanStatusCode } from "../lib/telemetry.ts"
import { verifyWebhookSignature } from "../lib/webhook-verify.ts"
import { handleWebhookEvent } from "../lib/webhook-handler.ts"
import {
  upsertGithubInstallation,
  updateGithubInstallationStatus,
} from "../db/queries/organizations.ts"
import {
  upsertRepoInventory,
  deactivateRepos,
  deactivateAllReposForInstallation,
  reactivateRepos,
} from "../db/queries/repositories.ts"

export const webhooksRoute = new Hono()

const GITHUB_WEBHOOK_MAX_BYTES = 1_000_000
const GITHUB_WEBHOOK_RATE_LIMIT = {
  bucket: "github-webhook",
  limit: 60,
  windowMs: 60_000,
} as const

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
  const rateLimitResponse = enforceRateLimit(c, GITHUB_WEBHOOK_RATE_LIMIT)
  if (rateLimitResponse) {
    return rateLimitResponse
  }

  const event = c.req.header("x-github-event")
  const signature = c.req.header("x-hub-signature-256")
  const deliveryId = c.req.header("x-github-delivery")

  let body: string
  try {
    body = await readRequestBodyText(c.req.raw, GITHUB_WEBHOOK_MAX_BYTES)
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return c.json(
        { error: { code: "PAYLOAD_TOO_LARGE", message: "webhook payload too large" } },
        413,
      )
    }
    throw err
  }

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
      repoGithubId: payload.repository.id,
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

    // Fire-and-forget but wrapped in a span for trace context propagation
    // All logs emitted during handling will have trace_id set
    withSpan(
      `webhook.process.pull_request.${action}`,
      async (span) => {
        span.setAttributes({
          "webhook.delivery_id": deliveryId ?? "unknown",
          "webhook.event": "pull_request",
          "webhook.action": action,
          "git.repository": `${context.owner}/${context.repo}`,
          "git.commit.sha": headSha,
          "pr.number": prNumber,
        })
        try {
          await handleWebhookEvent(context)
          logger.info("webhook processing completed", {
            "webhook.delivery_id": deliveryId ?? "unknown",
            "webhook.event": "pull_request",
            "webhook.action": action,
            "pr.number": prNumber,
          })
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) })
          span.recordException(err instanceof Error ? err : new Error(String(err)))
          logger.error(`error handling PR event for ${context.owner}/${context.repo}#${context.prNumber}`, {
            "webhook.delivery_id": deliveryId ?? "unknown",
            "yaffle.owner": context.owner,
            "yaffle.repo": context.repo,
            "yaffle.pr_number": context.prNumber,
            "error": err instanceof Error ? err.message : String(err),
          })
        }
      },
      { kind: SpanKind.CONSUMER },
    )

    return c.json({ data: { received: true } })
  }

  if (event === "push") {
    const ref = payload.ref as string

    // Determine ref type and extract name
    let refType: RefType
    let refName: string
    if (ref.startsWith("refs/heads/")) {
      refType = "branch"
      refName = ref.replace("refs/heads/", "")
    } else if (ref.startsWith("refs/tags/")) {
      refType = "tag"
      refName = ref.replace("refs/tags/", "")
    } else {
      return c.json({ data: { ignored: true, reason: `unsupported ref type: ${ref}` } })
    }

    // Log both `after` and `head_commit.id` to diagnose SHA discrepancies
    const afterSha = payload.after as string
    const headCommitSha = payload.head_commit?.id as string | undefined
    const beforeSha = payload.before as string
    console.log(`[webhook] push event: ref=${ref} refType=${refType} after=${afterSha} head_commit=${headCommitSha} before=${beforeSha}`)
    logger.info(`push webhook received`, {
      "webhook.ref": ref,
      "webhook.ref_type": refType,
      "webhook.ref_name": refName,
      "webhook.after": afterSha,
      "webhook.head_commit_id": headCommitSha ?? "none",
      "webhook.before": beforeSha,
      "webhook.sha_match": afterSha === headCommitSha,
    })

    // Ignore deletion events (after SHA is all zeros)
    const nullSha = "0000000000000000000000000000000000000000"
    if (!afterSha || afterSha === nullSha) {
      return c.json({ data: { ignored: true, reason: `${refType} deletion push (no head SHA)` } })
    }

    const context: PushContext = {
      kind: "push",
      installationId: payload.installation?.id,
      repoGithubId: payload.repository.id,
      ownerGithubId: payload.repository.owner.id,
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      headSha: payload.after,
      ref,
      refType,
      refName,
      pusherGithubId: payload.sender?.id ?? null,
      pusherLogin: payload.sender?.login ?? null,
      defaultBranch: payload.repository.default_branch,
    }

    // Fire-and-forget but wrapped in a span for trace context propagation
    withSpan(
      "webhook.process.push",
      async (span) => {
        span.setAttributes({
          "webhook.delivery_id": deliveryId ?? "unknown",
          "webhook.event": "push",
          "git.repository": `${context.owner}/${context.repo}`,
          "git.commit.sha": afterSha,
          "git.ref": ref,
          "git.ref.type": refType,
          "git.ref.name": refName,
        })
        try {
          await handleWebhookEvent(context)
          logger.info("webhook processing completed", {
            "webhook.delivery_id": deliveryId ?? "unknown",
            "webhook.event": "push",
            "git.ref": ref,
          })
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) })
          span.recordException(err instanceof Error ? err : new Error(String(err)))
          logger.error(`error handling push event for ${context.owner}/${context.repo}@${context.ref}`, {
            "webhook.delivery_id": deliveryId ?? "unknown",
            "yaffle.owner": context.owner,
            "yaffle.repo": context.repo,
            "yaffle.ref": context.ref,
            "error": err instanceof Error ? err.message : String(err),
          })
        }
      },
      { kind: SpanKind.CONSUMER },
    )

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
      // App was installed — update installation inventory and track repos
      // Org creation is now handled separately via POST /api/orgs
      await upsertGithubInstallation({ githubOrgId: githubId, githubOrgLogin: login, installationId })

      // Track initial repositories as inventory
      const repos = payload.repositories ?? []
      for (const repo of repos) {
        await upsertRepoInventory({
          installationId,
          githubId: repo.id,
          name: repo.name,
          fullName: repo.full_name,
        })
      }

      logger.info(`installation created: github_org=${login} repos=${repos.length}`, {
        "yaffle.github_org": login,
        "yaffle.installation_id": installationId,
        "yaffle.repo_count": repos.length,
      })

      return c.json({ data: { received: true, action: "installation_created" } })
    }

    if (action === "deleted") {
      // App was uninstalled — mark installation as uninstalled and deactivate repos
      await updateGithubInstallationStatus(installationId, "uninstalled")
      await deactivateAllReposForInstallation(installationId)

      logger.info(`installation deleted: github_org=${login}`, {
        "yaffle.github_org": login,
        "yaffle.installation_id": installationId,
      })

      return c.json({ data: { received: true, action: "installation_deleted" } })
    }

    if (action === "suspend") {
      await updateGithubInstallationStatus(installationId, "suspended")
      logger.info(`installation suspended: github_org=${login}`, {
        "yaffle.github_org": login,
        "yaffle.installation_id": installationId,
      })
      return c.json({ data: { received: true, action: "installation_suspended" } })
    }

    if (action === "unsuspend") {
      await updateGithubInstallationStatus(installationId, "active")
      logger.info(`installation unsuspended: github_org=${login}`, {
        "yaffle.github_org": login,
        "yaffle.installation_id": installationId,
      })
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

    if (action === "added") {
      const addedRepos = payload.repositories_added ?? []
      for (const repo of addedRepos) {
        await upsertRepoInventory({
          installationId,
          githubId: repo.id,
          name: repo.name,
          fullName: repo.full_name,
        })
      }
      // Reactivate any that were previously removed
      await reactivateRepos(addedRepos.map((r: { id: number }) => r.id))

      logger.info(`repos added to installation: github_org=${login} count=${addedRepos.length}`, {
        "yaffle.github_org": login,
        "yaffle.installation_id": installationId,
        "yaffle.repo_count": addedRepos.length,
      })

      return c.json({ data: { received: true, action: "repos_added" } })
    }

    if (action === "removed") {
      const removedRepos = payload.repositories_removed ?? []
      await deactivateRepos(removedRepos.map((r: { id: number }) => r.id))

      logger.info(`repos removed from installation: github_org=${login} count=${removedRepos.length}`, {
        "yaffle.github_org": login,
        "yaffle.installation_id": installationId,
        "yaffle.repo_count": removedRepos.length,
      })

      return c.json({ data: { received: true, action: "repos_removed" } })
    }

    return c.json({ data: { ignored: true, reason: `unhandled installation_repositories action: ${action}` } })
  }

  return c.json({ data: { ignored: true, reason: `unhandled event: ${event}` } })
})
