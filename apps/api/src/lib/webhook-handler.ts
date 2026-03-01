import type { WebhookContext } from "@yaffle/shared"

import { createCheckRun, updateCheckRun } from "./github.ts"

const CHECK_NAME = "Yaffle / terraform"

/**
 * Handle a pull_request webhook event.
 * This is the core dispatch that routes PR lifecycle events
 * to the appropriate preview operations.
 */
export async function handlePullRequestEvent(ctx: WebhookContext): Promise<void> {
  const tag = `${ctx.owner}/${ctx.repo}#${ctx.prNumber}`
  console.log(`handling PR event: ${tag} action=${ctx.action} sha=${ctx.headSha}`)

  switch (ctx.action) {
    case "opened":
    case "reopened":
    case "synchronize":
      await handlePlanRequested(ctx)
      break

    case "closed":
      if (ctx.merged) {
        await handleMerged(ctx)
      } else {
        await handleClosed(ctx)
      }
      break
  }
}

/**
 * PR opened/updated -- create a check run and kick off a plan.
 */
async function handlePlanRequested(ctx: WebhookContext): Promise<void> {
  const tag = `${ctx.owner}/${ctx.repo}#${ctx.prNumber}`

  if (!ctx.installationId) {
    console.warn(`no installation ID for ${tag}, skipping check run`)
    return
  }

  // Create the check run in "queued" state
  const checkRunId = await createCheckRun(ctx.installationId, {
    owner: ctx.owner,
    repo: ctx.repo,
    headSha: ctx.headSha,
    name: CHECK_NAME,
    status: "queued",
    title: "Terraform plan queued",
    summary: `Planning infrastructure changes for PR #${ctx.prNumber}...`,
  })

  console.log(`created check run ${checkRunId} for ${tag}`)

  // Mark as in_progress
  await updateCheckRun(ctx.installationId, ctx.owner, ctx.repo, checkRunId, {
    status: "in_progress",
    title: "Running terraform plan",
    summary: `Analyzing infrastructure changes for PR #${ctx.prNumber}...`,
  })

  // TODO: actually run terraform plan here
  // For now, complete with a placeholder
  await updateCheckRun(ctx.installationId, ctx.owner, ctx.repo, checkRunId, {
    status: "completed",
    conclusion: "success",
    title: "Terraform plan complete",
    summary: "Plan: +0, ~0, -0 (no TF runner wired up yet)",
    text: "The Yaffle TF runner is not yet connected. This is a placeholder check.",
  })

  console.log(`completed check run ${checkRunId} for ${tag}`)
}

/**
 * PR merged -- apply to production and clean up preview.
 */
async function handleMerged(ctx: WebhookContext): Promise<void> {
  const tag = `${ctx.owner}/${ctx.repo}#${ctx.prNumber}`
  console.log(`PR ${tag} was merged, would apply to production and destroy preview`)
  // TODO: apply production, destroy preview workspace
}

/**
 * PR closed without merge -- destroy preview resources.
 */
async function handleClosed(ctx: WebhookContext): Promise<void> {
  const tag = `${ctx.owner}/${ctx.repo}#${ctx.prNumber}`
  console.log(`PR ${tag} was closed, would destroy preview`)
  // TODO: destroy preview workspace
}
