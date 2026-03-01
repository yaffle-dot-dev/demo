import { Hono } from "hono"

import type { PullRequestAction, WebhookContext } from "@yaffle/shared"

import { getEnv } from "../lib/env.ts"
import { verifyWebhookSignature } from "../lib/webhook-verify.ts"
import { handlePullRequestEvent } from "../lib/webhook-handler.ts"

export const webhooksRoute = new Hono()

const SUPPORTED_PR_ACTIONS: PullRequestAction[] = [
  "opened",
  "synchronize",
  "closed",
  "reopened",
]

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
    console.error("webhook verification failed:", err)
    return c.json(
      { error: { code: "WEBHOOK_VERIFICATION_FAILED", message: "invalid signature" } },
      401,
    )
  }

  console.log(`webhook received: event=${event} delivery=${deliveryId}`)

  // We only care about pull_request events for now
  if (event !== "pull_request") {
    return c.json({ data: { ignored: true, reason: `unhandled event: ${event}` } })
  }

  const payload = JSON.parse(body)
  const action = payload.action as string

  if (!SUPPORTED_PR_ACTIONS.includes(action as PullRequestAction)) {
    return c.json({ data: { ignored: true, reason: `unhandled PR action: ${action}` } })
  }

  const context: WebhookContext = {
    installationId: payload.installation?.id,
    ownerGithubId: payload.repository.owner.id,
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    prNumber: payload.pull_request.number,
    action: action as PullRequestAction,
    headSha: payload.pull_request.head.sha,
    branch: payload.pull_request.head.ref,
    merged: payload.pull_request.merged ?? false,
  }

  // Handle asynchronously -- return 200 immediately, process in background
  // In production this would enqueue a job; for now we just fire-and-forget
  handlePullRequestEvent(context).catch((err) => {
    console.error(`error handling PR event for ${context.owner}/${context.repo}#${context.prNumber}:`, err)
  })

  return c.json({ data: { received: true } })
})
