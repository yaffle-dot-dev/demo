/**
 * Apply callbacks - notify external systems after successful terraform apply.
 *
 * Supports:
 * - Webhook: POST outputs to a URL
 * - GitHub dispatch: trigger repository_dispatch event
 */

import { getInstallationToken } from "./github.ts"
import { logger, withSpan } from "./telemetry.ts"

export interface ApplyCallbackContext {
  owner: string
  repo: string
  prNumber: number
  branch: string
  headSha: string
  workspacePath: string
  previewId: string
  outputs: Record<string, unknown>
}

export interface OnApplyConfig {
  webhook?: string
  github_dispatch?: {
    repo: string
    event: string
  }
}

/**
 * Execute all configured apply callbacks.
 * Failures are logged but don't fail the apply.
 */
export async function executeApplyCallbacks(
  config: OnApplyConfig | undefined,
  ctx: ApplyCallbackContext,
  installationId?: number,
): Promise<void> {
  if (!config) return

  const promises: Promise<void>[] = []

  if (config.webhook) {
    promises.push(sendWebhook(config.webhook, ctx))
  }

  if (config.github_dispatch && installationId) {
    promises.push(sendGithubDispatch(config.github_dispatch, ctx, installationId))
  }

  await Promise.allSettled(promises)
}

/**
 * POST outputs to a webhook URL.
 */
async function sendWebhook(
  url: string,
  ctx: ApplyCallbackContext,
): Promise<void> {
  return withSpan("apply.callback.webhook", async (span) => {
    span.setAttributes({
      "callback.type": "webhook",
      "callback.url": url,
      "yaffle.owner": ctx.owner,
      "yaffle.repo": ctx.repo,
      "yaffle.workspace_path": ctx.workspacePath,
    })

    const payload = {
      event: "apply.success",
      timestamp: new Date().toISOString(),
      preview: {
        id: ctx.previewId,
        owner: ctx.owner,
        repo: ctx.repo,
        prNumber: ctx.prNumber,
        branch: ctx.branch,
        headSha: ctx.headSha,
        workspacePath: ctx.workspacePath,
      },
      outputs: ctx.outputs,
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Yaffle/1.0",
          "X-Yaffle-Event": "apply.success",
        },
        body: JSON.stringify(payload),
      })

      span.setAttributes({ "http.status_code": response.status })

      if (!response.ok) {
        logger.warn("webhook callback failed", {
          url,
          status: response.status,
          "yaffle.owner": ctx.owner,
          "yaffle.repo": ctx.repo,
        })
      } else {
        logger.info("webhook callback sent", {
          url,
          status: response.status,
          "yaffle.owner": ctx.owner,
          "yaffle.repo": ctx.repo,
        })
      }
    } catch (err) {
      logger.warn("webhook callback error", {
        url,
        error: err instanceof Error ? err.message : String(err),
        "yaffle.owner": ctx.owner,
        "yaffle.repo": ctx.repo,
      })
    }
  })
}

/**
 * Trigger a GitHub repository_dispatch event.
 */
async function sendGithubDispatch(
  config: { repo: string; event: string },
  ctx: ApplyCallbackContext,
  installationId: number,
): Promise<void> {
  return withSpan("apply.callback.github_dispatch", async (span) => {
    span.setAttributes({
      "callback.type": "github_dispatch",
      "callback.target_repo": config.repo,
      "callback.event_type": config.event,
      "yaffle.owner": ctx.owner,
      "yaffle.repo": ctx.repo,
      "yaffle.workspace_path": ctx.workspacePath,
    })

    try {
      const token = await getInstallationToken(installationId)

      // Parse target repo (can be "owner/repo" or just "repo" for same owner)
      let targetOwner = ctx.owner
      let targetRepo = config.repo
      if (config.repo.includes("/")) {
        const parts = config.repo.split("/")
        targetOwner = parts[0]
        targetRepo = parts[1]
      }

      const url = `https://api.github.com/repos/${targetOwner}/${targetRepo}/dispatches`

      const payload = {
        event_type: config.event,
        client_payload: {
          yaffle: {
            preview_id: ctx.previewId,
            owner: ctx.owner,
            repo: ctx.repo,
            pr_number: ctx.prNumber,
            branch: ctx.branch,
            head_sha: ctx.headSha,
            workspace_path: ctx.workspacePath,
          },
          outputs: ctx.outputs,
        },
      }

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "Yaffle/1.0",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify(payload),
      })

      span.setAttributes({ "http.status_code": response.status })

      // GitHub returns 204 No Content on success
      if (response.status === 204 || response.ok) {
        logger.info("github dispatch sent", {
          targetRepo: `${targetOwner}/${targetRepo}`,
          eventType: config.event,
          "yaffle.owner": ctx.owner,
          "yaffle.repo": ctx.repo,
        })
      } else {
        const text = await response.text()
        logger.warn("github dispatch failed", {
          targetRepo: `${targetOwner}/${targetRepo}`,
          status: response.status,
          body: text,
          "yaffle.owner": ctx.owner,
          "yaffle.repo": ctx.repo,
        })
      }
    } catch (err) {
      logger.warn("github dispatch error", {
        targetRepo: config.repo,
        error: err instanceof Error ? err.message : String(err),
        "yaffle.owner": ctx.owner,
        "yaffle.repo": ctx.repo,
      })
    }
  })
}
