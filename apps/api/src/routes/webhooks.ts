import { Hono } from "hono"

import type {
  PullRequestAction,
  PullRequestContext,
  PushContext,
} from "@yaffle/shared"

import { getEnv } from "../lib/env.ts"
import { verifyWebhookSignature } from "../lib/webhook-verify.ts"
import { handleWebhookEvent } from "../lib/webhook-handler.ts"

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

  const payload = JSON.parse(body)

  if (event === "pull_request") {
    const action = payload.action as string

    if (!SUPPORTED_PR_ACTIONS.includes(action as PullRequestAction)) {
      return c.json({ data: { ignored: true, reason: `unhandled PR action: ${action}` } })
    }

    const context: PullRequestContext = {
      kind: "pull_request",
      installationId: payload.installation?.id,
      ownerGithubId: payload.repository.owner.id,
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      prNumber: payload.pull_request.number,
      action: action as PullRequestAction,
      headSha: payload.pull_request.head.sha,
      branch: payload.pull_request.head.ref,
      merged: payload.pull_request.merged ?? false,
      defaultBranch: payload.repository.default_branch,
    }

    handleWebhookEvent(context).catch((err) => {
      console.error(
        `error handling PR event for ${context.owner}/${context.repo}#${context.prNumber}:`,
        err,
      )
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

    const context: PushContext = {
      kind: "push",
      installationId: payload.installation?.id,
      ownerGithubId: payload.repository.owner.id,
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      headSha: payload.after,
      branch,
      defaultBranch: payload.repository.default_branch,
    }

    handleWebhookEvent(context).catch((err) => {
      console.error(
        `error handling push event for ${context.owner}/${context.repo}@${context.branch}:`,
        err,
      )
    })

    return c.json({ data: { received: true } })
  }

  return c.json({ data: { ignored: true, reason: `unhandled event: ${event}` } })
})
