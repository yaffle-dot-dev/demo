import { eq } from "drizzle-orm"

import type { WebhookContext } from "@yaffle/shared"

import { db } from "./db.ts"
import { getEnv } from "./env.ts"
import { createCheckRun, updateCheckRun } from "./github.ts"
import { getRunGroupCheckSummary } from "./run-group-check-copy.ts"
import { deriveRunGroupLifecycleState } from "./lifecycle-conditions.ts"
import { logger } from "./telemetry.ts"
import { getLifecycleStateForRunGroup } from "../db/queries/lifecycle.ts"
import { findGithubInstallationsForOrg } from "../db/queries/organizations.ts"
import { findRepoByInstallationAndName } from "../db/queries/repositories.ts"
import { iacJobs, organizations, runGroups, workspaceDeployments } from "../db/schema.ts"

const CHECK_NAME = "Yaffle / run"

interface RunGroupCheckContext {
  id: string
  orgId: string
  orgSlug: string
  repo: string
  environmentName: string
  headSha: string
  checkRunId: number | null
  checkCompletedAt: Date | null
}

export async function createPendingRunGroupCheck(
  ctx: WebhookContext,
  params: {
    runGroupId: string
    orgSlug: string
    environmentName: string
  },
): Promise<void> {
  if (ctx.installationId == null) return

  const detailsUrl = buildRunGroupDetailsUrl({
    id: params.runGroupId,
    orgSlug: params.orgSlug,
    repo: ctx.repo,
    environmentName: params.environmentName,
  })

  try {
    const checkRunId = await createCheckRun(ctx.installationId, {
      owner: ctx.owner,
      repo: ctx.repo,
      headSha: ctx.headSha,
      name: CHECK_NAME,
      status: "in_progress",
      detailsUrl,
      title: "Pending",
      summary: formatCheckSummary(getRunGroupCheckSummary("pending"), detailsUrl),
    })

    await db
      .update(runGroups)
      .set({ checkRunId })
      .where(eq(runGroups.id, params.runGroupId))
  } catch (err) {
    logger.warn("failed to create pending check run", {
      runGroupId: params.runGroupId,
      owner: ctx.owner,
      repo: ctx.repo,
      headSha: ctx.headSha,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function surfaceConfigErrorCheck(
  ctx: WebhookContext,
  message: string,
): Promise<void> {
  if (ctx.installationId == null) return

  try {
    await createCheckRun(ctx.installationId, {
      owner: ctx.owner,
      repo: ctx.repo,
      headSha: ctx.headSha,
      name: CHECK_NAME,
      status: "completed",
      conclusion: "failure",
      title: "Configuration error",
      summary: message,
    })
  } catch (err) {
    logger.warn("failed to create config error check run", {
      owner: ctx.owner,
      repo: ctx.repo,
      headSha: ctx.headSha,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function completeRunGroupCheck(params: {
  runGroupId: string
  conclusion: "success" | "failure" | "cancelled"
  title?: string
  summary?: string
  detailsUrl?: string
}): Promise<void> {
  const context = await loadRunGroupCheckContext(params.runGroupId)
  if (!context || context.checkCompletedAt) {
    return
  }

  const installation = (await findGithubInstallationsForOrg(context.orgId)).find((candidate) =>
    candidate.installationStatus === "active"
  )

  if (!installation) {
    logger.warn("Skipping run group check completion: no active GitHub installation", {
      runGroupId: params.runGroupId,
      orgId: context.orgId,
      repo: context.repo,
      headSha: context.headSha,
    })
    return
  }

  const repoRecord = await findRepoByInstallationAndName(installation.installationId, context.repo)
  const owner = repoRecord?.fullName.split("/")[0] ?? installation.githubOrgLogin
  const title = params.title ?? defaultTitleForConclusion(params.conclusion)
  const detailsUrl = params.detailsUrl ?? buildRunGroupDetailsUrl(context)
  const summary = formatCheckSummary(
    params.summary ?? defaultSummaryForConclusion(params.conclusion),
    detailsUrl,
  )

  try {
    let checkRunId = context.checkRunId
    if (checkRunId) {
      await updateCheckRun(installation.installationId, owner, context.repo, checkRunId, {
        status: "completed",
        conclusion: params.conclusion,
        detailsUrl,
        title,
        summary,
      })
    } else {
      checkRunId = await createCheckRun(installation.installationId, {
        owner,
        repo: context.repo,
        headSha: context.headSha,
        name: CHECK_NAME,
        status: "completed",
        conclusion: params.conclusion,
        detailsUrl,
        title,
        summary,
      })
    }

    await db
      .update(runGroups)
      .set({
        checkRunId,
        checkCompletedAt: new Date(),
      })
      .where(eq(runGroups.id, params.runGroupId))
  } catch (err) {
    logger.warn("failed to complete run group check run", {
      runGroupId: params.runGroupId,
      owner,
      repo: context.repo,
      headSha: context.headSha,
      installationId: installation.installationId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function syncRunGroupCheckFromDeployments(runGroupId: string): Promise<void> {
  const context = await loadRunGroupCheckContext(runGroupId)
  if (!context || context.checkCompletedAt) {
    return
  }

  const deployments = await db
    .select({
      status: workspaceDeployments.status,
      workspacePath: workspaceDeployments.workspacePath,
    })
    .from(workspaceDeployments)
    .where(eq(workspaceDeployments.runGroupId, runGroupId))

  if (deployments.length === 0) {
    return
  }

  const statuses = deployments.map((deployment) => deployment.status)

  if (statuses.some((status) => status === "failed" || status === "system_error")) {
    await completeRunGroupCheck({
      runGroupId,
      conclusion: "failure",
    })
    return
  }

  const activeJobs = await db
    .select({ id: iacJobs.id })
    .from(iacJobs)
    .innerJoin(workspaceDeployments, eq(workspaceDeployments.id, iacJobs.deploymentId))
    .where(eq(workspaceDeployments.runGroupId, runGroupId))
    .limit(1)

  if (activeJobs.length > 0) {
    return
  }

  const lifecycleState = await getLifecycleStateForRunGroup(runGroupId)
  const lifecycle = deriveRunGroupLifecycleState({
    deployments,
    items: (lifecycleState?.items ?? []).map((item) => ({
      workspacePath: item.workspacePath,
      phase: item.phase,
      state: item.state,
      scopes: item.scopes,
    })),
  })

  if (!lifecycle.isComplete) {
    return
  }

  await completeRunGroupCheck({
    runGroupId,
    conclusion: lifecycle.status === "success" ? "success" : "failure",
    ...(lifecycle.status === "partial"
      ? {
          title: "Settled with degradation",
          summary: "Yaffle finished the infrastructure changes for this commit, but an acceptable lifecycle check settled degraded.",
        }
      : {}),
  })
}

async function loadRunGroupCheckContext(runGroupId: string): Promise<RunGroupCheckContext | undefined> {
  const rows = await db
    .select({
      id: runGroups.id,
      orgId: runGroups.orgId,
      orgSlug: organizations.slug,
      repo: runGroups.repo,
      environmentName: runGroups.environmentName,
      headSha: runGroups.headSha,
      checkRunId: runGroups.checkRunId,
      checkCompletedAt: runGroups.checkCompletedAt,
    })
    .from(runGroups)
    .innerJoin(organizations, eq(organizations.id, runGroups.orgId))
    .where(eq(runGroups.id, runGroupId))
    .limit(1)

  return rows[0]
}

function defaultTitleForConclusion(conclusion: "success" | "failure" | "cancelled"): string {
  switch (conclusion) {
    case "success":
      return "Succeeded"
    case "failure":
      return "Failed"
    case "cancelled":
      return "Cancelled"
  }
}

function defaultSummaryForConclusion(conclusion: "success" | "failure" | "cancelled"): string {
  switch (conclusion) {
    case "success":
      return getRunGroupCheckSummary("success")
    case "failure":
      return getRunGroupCheckSummary("failure")
    case "cancelled":
      return getRunGroupCheckSummary("cancelled")
  }
}

function buildRunGroupDetailsUrl(context: Pick<RunGroupCheckContext, "id" | "orgSlug" | "repo" | "environmentName">): string | undefined {
  const baseUrl = getEnv().betterAuthUrl.trim()
  if (!baseUrl) {
    return undefined
  }

  const url = new URL(baseUrl)
  const basePath = url.pathname.replace(/\/$/, "")
  const appBasePath = basePath.endsWith("/app") ? basePath : `${basePath}/app`

  url.pathname =
    `${appBasePath}/${encodeURIComponent(context.orgSlug)}` +
    `/${encodeURIComponent(context.repo)}/env/${encodeURIComponent(context.environmentName)}`
  url.search = ""

  url.searchParams.set("runGroupId", context.id)
  return url.toString()
}

function formatCheckSummary(summary: string, detailsUrl: string | undefined): string {
  if (!detailsUrl) {
    return summary
  }

  return `${summary}\n\n[${buildDetailsLabel(detailsUrl)}](${detailsUrl})`
}

function buildDetailsLabel(detailsUrl: string): string {
  try {
    return `View more details at ${new URL(detailsUrl).hostname}`
  } catch {
    return "View more details"
  }
}
