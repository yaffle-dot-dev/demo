import type { TerraformResult, WebhookContext } from "@yaffle/shared"

import { ensureOrg } from "../db/queries/organizations.ts"
import { findPreview, updatePreviewStatus, upsertPreview } from "../db/queries/previews.ts"
import { createTfRun, updateRunStatus } from "../db/queries/tf-runs.ts"
import { createCheckRun, getInstallationToken, updateCheckRun } from "./github.ts"
import { LocalRunner } from "./local-runner.ts"
import type { Runner } from "./runner.ts"

const CHECK_NAME = "Yaffle / terraform"

/** Default runner for production use. Override via createHandler() for tests. */
const defaultRunner: Runner = new LocalRunner()

/**
 * Create a handler with an injected runner. Used by tests to avoid
 * real git clone + tofu invocations.
 */
export function createHandler(runner: Runner): {
  handlePullRequestEvent: (ctx: WebhookContext) => Promise<void>
} {
  return {
    handlePullRequestEvent: (ctx: WebhookContext) =>
      handlePullRequestEventWith(ctx, runner),
  }
}

/**
 * Handle a pull_request webhook event using the default runner.
 */
export async function handlePullRequestEvent(ctx: WebhookContext): Promise<void> {
  return handlePullRequestEventWith(ctx, defaultRunner)
}

/**
 * Acquire an installation token for private repo access.
 * Returns undefined if no installation ID or if token acquisition fails.
 */
async function acquireToken(ctx: WebhookContext): Promise<string | undefined> {
  if (!ctx.installationId) return undefined
  try {
    return await getInstallationToken(ctx.installationId)
  } catch (err) {
    console.warn(`failed to get installation token:`, err)
    return undefined
  }
}

async function handlePullRequestEventWith(
  ctx: WebhookContext,
  runner: Runner,
): Promise<void> {
  const tag = `${ctx.owner}/${ctx.repo}#${ctx.prNumber}`
  console.log(`handling PR event: ${tag} action=${ctx.action} sha=${ctx.headSha}`)

  switch (ctx.action) {
    case "opened":
    case "reopened":
    case "synchronize":
      await handlePlanRequested(ctx, runner)
      break

    case "closed":
      if (ctx.merged) {
        await handleMerged(ctx, runner)
      } else {
        await handleClosed(ctx, runner)
      }
      break
  }
}

/**
 * PR opened/updated -- persist preview + run, create check, run plan.
 */
async function handlePlanRequested(ctx: WebhookContext, runner: Runner): Promise<void> {
  const tag = `${ctx.owner}/${ctx.repo}#${ctx.prNumber}`

  // 1. Ensure the org exists in our DB
  const org = await ensureOrg(ctx.owner, ctx.ownerGithubId)
  console.log(`org resolved: ${org.login} (${org.id})`)

  // 2. Upsert the preview record
  const stateKey = `previews/pr-${ctx.prNumber}/terraform.tfstate`
  const preview = await upsertPreview({
    orgId: org.id,
    repo: ctx.repo,
    prNumber: ctx.prNumber,
    branch: ctx.branch,
    headSha: ctx.headSha,
    stateKey,
    mode: "terraform",
  })
  console.log(`preview upserted: ${preview.id} status=${preview.status}`)

  // 3. Mark preview as planning
  await updatePreviewStatus(preview.id, "planning")

  // 4. Create a plan run record
  const run = await createTfRun({
    previewId: preview.id,
    runType: "plan",
    status: "pending",
  })
  console.log(`tf_run created: ${run.id} type=${run.runType}`)

  // 5. Create the GitHub check run (if we have an installation)
  let checkRunId: number | undefined
  if (ctx.installationId) {
    try {
      checkRunId = await createCheckRun(ctx.installationId, {
        owner: ctx.owner,
        repo: ctx.repo,
        headSha: ctx.headSha,
        name: CHECK_NAME,
        status: "queued",
        title: "Terraform plan queued",
        summary: `Planning infrastructure changes for PR #${ctx.prNumber}...`,
      })
      console.log(`check run ${checkRunId} created for ${tag}`)
    } catch (err) {
      console.warn(`failed to create check run for ${tag}:`, err)
    }
  }

  // 6. Mark run as running
  await updateRunStatus(run.id, "running", {
    checkRunId,
    startedAt: new Date(),
  })

  if (checkRunId && ctx.installationId) {
    await updateCheckRun(ctx.installationId, ctx.owner, ctx.repo, checkRunId, {
      status: "in_progress",
      title: "Running terraform plan",
      summary: `Analyzing infrastructure changes for PR #${ctx.prNumber}...`,
    }).catch((err) => console.warn(`failed to update check run:`, err))
  }

  // 7. Get installation token for private repo clone
  const installationToken = await acquireToken(ctx)

  // 8. Run terraform plan via the runner
  try {
    const result = await runner.run({
      owner: ctx.owner,
      repo: ctx.repo,
      headSha: ctx.headSha,
      command: "plan",
      variables: { environment: `preview-pr-${ctx.prNumber}` },
      installationToken,
    })

    console.log(
      `plan result: success=${result.success} summary=${result.planSummary} duration=${result.durationMs}ms`,
    )

    await completePlan(run.id, preview.id, ctx, checkRunId, result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`plan failed for ${tag}:`, msg)

    await updateRunStatus(run.id, "failed", {
      completedAt: new Date(),
      errorMessage: msg,
    })
    await updatePreviewStatus(preview.id, "failed")

    if (checkRunId && ctx.installationId) {
      await updateCheckRun(ctx.installationId, ctx.owner, ctx.repo, checkRunId, {
        status: "completed",
        conclusion: "failure",
        title: "Terraform plan failed",
        summary: msg,
      }).catch((err) => console.warn(`failed to update check run:`, err))
    }
  }
}

/**
 * Finalize a plan run -- update DB records and GitHub check.
 */
async function completePlan(
  runId: string,
  previewId: string,
  ctx: WebhookContext,
  checkRunId: number | undefined,
  result: TerraformResult,
): Promise<void> {
  if (result.success) {
    await updateRunStatus(runId, "success", {
      completedAt: new Date(),
      planSummary: result.planSummary,
      planJson: result.planJson,
    })
    await updatePreviewStatus(previewId, "ready")
  } else {
    await updateRunStatus(runId, "failed", {
      completedAt: new Date(),
      errorMessage: result.errorMessage,
    })
    await updatePreviewStatus(previewId, "failed")
  }

  if (checkRunId && ctx.installationId) {
    // Truncate plan output if it's too long for GitHub (max 65535 chars)
    const MAX_TEXT_LENGTH = 65000
    let text = result.output
    if (text.length > MAX_TEXT_LENGTH) {
      text = `${text.slice(0, MAX_TEXT_LENGTH)}\n\n... (output truncated)`
    }

    // Wrap in a code block for formatting
    const formattedText = text ? `\`\`\`\n${text}\n\`\`\`` : undefined

    await updateCheckRun(ctx.installationId, ctx.owner, ctx.repo, checkRunId, {
      status: "completed",
      conclusion: result.success ? "success" : "failure",
      title: result.success
        ? `Terraform plan: ${result.planSummary ?? "complete"}`
        : "Terraform plan failed",
      summary: result.success
        ? `Plan: ${result.planSummary ?? "complete"}`
        : (result.errorMessage ?? "Plan failed"),
      text: formattedText,
    }).catch((err) => console.warn(`failed to update check run:`, err))
  }
}

/**
 * PR merged -- apply to production and clean up preview.
 */
async function handleMerged(ctx: WebhookContext, runner: Runner): Promise<void> {
  const tag = `${ctx.owner}/${ctx.repo}#${ctx.prNumber}`

  const org = await ensureOrg(ctx.owner, ctx.ownerGithubId)
  const preview = await findPreview(org.id, ctx.repo, ctx.prNumber)

  if (!preview) {
    console.warn(`no preview found for ${tag}, nothing to apply/destroy`)
    return
  }

  console.log(`PR ${tag} was merged, transitioning preview ${preview.id}`)

  const installationToken = await acquireToken(ctx)

  // Apply to production
  const applyRun = await createTfRun({
    previewId: preview.id,
    runType: "apply",
    status: "pending",
  })
  await updatePreviewStatus(preview.id, "applying")
  await updateRunStatus(applyRun.id, "running", { startedAt: new Date() })
  console.log(`created production apply run ${applyRun.id} for ${tag}`)

  try {
    const result = await runner.run({
      owner: ctx.owner,
      repo: ctx.repo,
      headSha: ctx.headSha,
      command: "apply",
      variables: { environment: "production" },
      installationToken,
    })

    if (result.success) {
      await updateRunStatus(applyRun.id, "success", {
        completedAt: new Date(),
        outputs: result.outputs,
      })
    } else {
      await updateRunStatus(applyRun.id, "failed", {
        completedAt: new Date(),
        errorMessage: result.errorMessage,
      })
      await updatePreviewStatus(preview.id, "failed")
      return
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await updateRunStatus(applyRun.id, "failed", {
      completedAt: new Date(),
      errorMessage: msg,
    })
    await updatePreviewStatus(preview.id, "failed")
    console.error(`apply failed for ${tag}:`, msg)
    return
  }

  // Destroy preview workspace
  await destroyPreview(ctx, preview.id, runner, installationToken)
}

/**
 * PR closed without merge -- destroy preview resources.
 */
async function handleClosed(ctx: WebhookContext, runner: Runner): Promise<void> {
  const tag = `${ctx.owner}/${ctx.repo}#${ctx.prNumber}`

  const org = await ensureOrg(ctx.owner, ctx.ownerGithubId)
  const preview = await findPreview(org.id, ctx.repo, ctx.prNumber)

  if (!preview) {
    console.warn(`no preview found for ${tag}, nothing to destroy`)
    return
  }

  console.log(`PR ${tag} was closed, destroying preview ${preview.id}`)

  const installationToken = await acquireToken(ctx)
  await destroyPreview(ctx, preview.id, runner, installationToken)
}

/**
 * Shared logic for destroying a preview workspace.
 */
async function destroyPreview(
  ctx: WebhookContext,
  previewId: string,
  runner: Runner,
  installationToken?: string,
): Promise<void> {
  const tag = `${ctx.owner}/${ctx.repo}#${ctx.prNumber}`

  const destroyRun = await createTfRun({
    previewId,
    runType: "destroy",
    status: "pending",
  })
  await updatePreviewStatus(previewId, "destroying")
  await updateRunStatus(destroyRun.id, "running", { startedAt: new Date() })

  try {
    const result = await runner.run({
      owner: ctx.owner,
      repo: ctx.repo,
      headSha: ctx.headSha,
      command: "destroy",
      installationToken,
    })

    if (result.success) {
      await updateRunStatus(destroyRun.id, "success", { completedAt: new Date() })
    } else {
      await updateRunStatus(destroyRun.id, "failed", {
        completedAt: new Date(),
        errorMessage: result.errorMessage,
      })
      await updatePreviewStatus(previewId, "failed")
      console.error(`destroy failed for ${tag}: ${result.errorMessage}`)
      return
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await updateRunStatus(destroyRun.id, "failed", {
      completedAt: new Date(),
      errorMessage: msg,
    })
    await updatePreviewStatus(previewId, "failed")
    console.error(`destroy failed for ${tag}:`, msg)
    return
  }

  await updatePreviewStatus(previewId, "destroyed")
  console.log(`preview ${previewId} destroyed for ${tag}`)
}
