import { Hono, type MiddlewareHandler } from "hono"
import { timingSafeEqual } from "node:crypto"
import { z } from "zod"

import type { PullRequestContext, PushContext, WebhookContext } from "@yaffle/shared"

import { createRunGroup, findRunGroupById } from "../db/queries/run-groups.ts"
import { listRunsForDeployments } from "../db/queries/tf-runs.ts"
import { findDeploymentsByRunGroup } from "../db/queries/workspace-deployments.ts"
import { ensurePrincipalRepoBinding } from "../db/queries/principals.ts"
import { getLifecycleStateForRunGroup, listLifecycleEventsForItems } from "../db/queries/lifecycle.ts"
import { findOrgById, findOrgMembership } from "../db/queries/organizations.ts"
import { findRepoByFullName } from "../db/queries/repositories.ts"
import { parseYaffleToml, type YaffleTomlConfig } from "../lib/config-toml.ts"
import {
  findPushTriggerEnvironment,
  getWorkspacesForEnvironment,
  matchesPullRequestTrigger,
  parsePrEnvironmentName,
} from "../lib/config-toml.ts"
import { fetchFileContent, getInstallationToken } from "../lib/github.ts"
import { logger } from "../lib/telemetry.ts"
import { buildWorkspaceVariablesByPath, type WorkspaceVariablesByPath } from "../lib/workspace-variables.ts"
import { principalAuth, type PrincipalAuthContext } from "../middleware/principal-auth.ts"
import { createScanJob } from "../db/queries/scan-jobs.ts"
import { generateScanJobToken } from "../lib/job-token.ts"
import { getScheduler } from "../lib/scheduler.ts"

type Variables = {
  principalAuth: PrincipalAuthContext
}

type ConfigLoader = (ctx: WebhookContext) => Promise<YaffleTomlConfig>
type InstallationTokenLoader = (installationId: number) => Promise<string>
type ScanDispatcher = (input: {
  ctx: WebhookContext
  orgId: string
  orgSlug: string
  runGroupId: string
  workspacePaths: string[]
  workspaceVariables: WorkspaceVariablesByPath
  installationToken: string
}) => Promise<{ scanJobId: string }>

const LOCAL_FIRST_FEATURE_TOKEN_ENV_VAR = "YAFFLE_LOCAL_FIRST_FEATURE_TOKEN"

const manualConvergeSchema = z.object({
  repoFullName: z.string().min(1),
  canonicalRepoNamespace: z.string().min(1),
  localRepoFingerprint: z.string().min(1),
  environmentName: z.string().min(1),
  ref: z.string().min(1),
  headSha: z.string().min(1),
  workspacePaths: z.array(z.string().min(1)).min(1),
})

const uuidParam = z.string().uuid()

export function createCloudConvergeRoute(deps: {
  loadConfig?: ConfigLoader
  loadInstallationToken?: InstallationTokenLoader
  scanDispatcher?: ScanDispatcher
} = {}): Hono<{ Variables: Variables }> {
  const route = new Hono<{ Variables: Variables }>()
  const loadConfig = deps.loadConfig ?? loadConfigFromGithub
  const loadInstallationToken = deps.loadInstallationToken ?? getInstallationToken
  const scanDispatcher = deps.scanDispatcher ?? dispatchManualScan

  route.use("/converge", enforceFeatureToken)
  route.use("/converge", principalAuth())

  route.post("/converge", async (c) => {
    const principal = c.get("principalAuth")
    if (principal.type !== "account" || !principal.userId) {
      return c.json(
        { error: { code: "PAID_CLOUD_REQUIRED", message: "remote converge requires a paid cloud account session" } },
        403,
      )
    }

    const body = await c.req.json().catch(() => null)
    const parsed = manualConvergeSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(
        { error: { code: "BAD_REQUEST", message: parsed.error.errors[0]?.message ?? "invalid request" } },
        400,
      )
    }

    const values = parsed.data
    const expectedNamespace = values.repoFullName.replace("/", "--")
    if (expectedNamespace !== values.canonicalRepoNamespace) {
      return c.json(
        {
          error: {
            code: "REPO_NAMESPACE_MISMATCH",
            message: `canonical repo namespace '${values.canonicalRepoNamespace}' does not match '${values.repoFullName}'`,
          },
        },
        400,
      )
    }
    const repo = await findRepoByFullName(values.repoFullName)
    if (!repo?.orgId) {
      return c.json({ error: { code: "REPO_NOT_FOUND", message: `repository not found: ${values.repoFullName}` } }, 404)
    }
    if (!repo.installationId) {
      return c.json(
        { error: { code: "REPO_NOT_CONNECTED", message: `repository ${values.repoFullName} is not connected to a GitHub App installation` } },
        409,
      )
    }

    const org = await findOrgById(repo.orgId)
    if (!org) {
      return c.json({ error: { code: "ORG_NOT_FOUND", message: "organization not found" } }, 404)
    }

    const membership = await findOrgMembership(org.id, principal.userId)
    if (!membership || !hasMinRole(membership.role, "approver")) {
      return c.json(
        { error: { code: "FORBIDDEN", message: "remote converge requires approver role or higher" } },
        403,
      )
    }
    if (!isPaidCloudOrg(org.planTier, org.subscriptionStatus)) {
      return c.json(
        { error: { code: "PAID_CLOUD_REQUIRED", message: "remote converge requires an active paid-cloud plan" } },
        403,
      )
    }

    const repoBinding = await ensurePrincipalRepoBinding({
      principalId: principal.principalId,
      canonicalRepoNamespace: values.canonicalRepoNamespace,
      localRepoFingerprint: values.localRepoFingerprint,
    })

    const ctx = buildManualWebhookContext({
      repoFullName: values.repoFullName,
      installationId: repo.installationId,
      repoGithubId: repo.githubId,
      defaultBranch: repo.defaultBranch,
      environmentName: values.environmentName,
      ref: values.ref,
      headSha: values.headSha,
    })
    const config = await loadConfig(ctx)

    if (!environmentMatchesRef(config, ctx, values.environmentName)) {
      return c.json(
        { error: { code: "TARGET_MISMATCH", message: `ref '${values.ref}' does not match environment '${values.environmentName}'` } },
        400,
      )
    }

    const eligibleWorkspacePaths = new Set(
      getWorkspacesForEnvironment(config, values.environmentName, ctx.kind === "pull_request"),
    )
    const selectedWorkspacePaths = [...new Set(values.workspacePaths)]
    const invalidWorkspacePaths = selectedWorkspacePaths.filter((workspacePath) =>
      !eligibleWorkspacePaths.has(workspacePath)
    )
    if (invalidWorkspacePaths.length > 0) {
      return c.json(
        {
          error: {
            code: "INVALID_SELECTION",
            message: `selected workspaces are not valid for ${values.environmentName}: ${invalidWorkspacePaths.join(", ")}`,
          },
        },
        400,
      )
    }

    const workspaceVariables = buildWorkspaceVariablesByPath(
      config,
      selectedWorkspacePaths,
      ctx,
      values.environmentName,
      ctx.kind === "pull_request" ? "transient" : "named",
    )

    const runGroup = await createRunGroup({
      orgId: org.id,
      repoBindingId: repoBinding.id,
      repo: repo.name,
      environmentKind: ctx.kind === "pull_request" ? "transient" : "named",
      environmentName: values.environmentName,
      prNumber: ctx.kind === "pull_request" ? ctx.prNumber : null,
      ref: values.ref,
      headSha: values.headSha,
      trigger: "manual",
      status: "pending",
    })

    const installationToken = await loadInstallationToken(repo.installationId)
    const { scanJobId } = await scanDispatcher({
      ctx,
      orgId: org.id,
      orgSlug: org.slug,
      runGroupId: runGroup.id,
      workspacePaths: selectedWorkspacePaths,
      workspaceVariables,
      installationToken,
    })

    logger.info("cloud.remote_converge_queued", {
      runGroupId: runGroup.id,
      scanJobId,
      orgId: org.id,
      repoFullName: values.repoFullName,
      environmentName: values.environmentName,
      workspaceCount: selectedWorkspacePaths.length,
      principalId: principal.principalId,
    })

    return c.json(
      {
        data: {
          runGroupId: runGroup.id,
          scanJobId,
          environmentName: values.environmentName,
          workspacePaths: selectedWorkspacePaths,
          ref: values.ref,
          headSha: values.headSha,
          status: "queued",
        },
      },
      202,
    )
  })

  route.get("/converge/:runGroupId", async (c) => {
    const principal = c.get("principalAuth")
    if (principal.type !== "account" || !principal.userId) {
      return c.json(
        { error: { code: "PAID_CLOUD_REQUIRED", message: "remote converge requires a paid cloud account session" } },
        403,
      )
    }

    const parsedRunGroupId = uuidParam.safeParse(c.req.param("runGroupId"))
    if (!parsedRunGroupId.success) {
      return c.json(
        { error: { code: "BAD_REQUEST", message: "runGroupId must be a valid UUID" } },
        400,
      )
    }

    const runGroup = await findRunGroupById(parsedRunGroupId.data)
    if (!runGroup) {
      return c.json({ error: { code: "NOT_FOUND", message: "run group not found" } }, 404)
    }

    const org = await findOrgById(runGroup.orgId)
    if (!org) {
      return c.json({ error: { code: "ORG_NOT_FOUND", message: "organization not found" } }, 404)
    }

    const membership = await findOrgMembership(org.id, principal.userId)
    if (!membership || !hasMinRole(membership.role, "viewer")) {
      return c.json(
        { error: { code: "FORBIDDEN", message: "run group access denied" } },
        403,
      )
    }

    const deployments = await findDeploymentsByRunGroup(runGroup.id)
    const latestRuns = await listRunsForDeployments(deployments.map((deployment) => deployment.id))
    const lifecycleState = await getLifecycleStateForRunGroup(runGroup.id)
    const lifecycleEvents = await listLifecycleEventsForItems(lifecycleState?.items.map((item) => item.id) ?? [])

    const runGroupStatus = deriveCloudConvergeRunGroupStatus(runGroup.status, lifecycleState?.run.status)

    return c.json({
      data: {
        runGroup: {
          id: runGroup.id,
          status: runGroupStatus,
          repo: runGroup.repo,
          environmentKind: runGroup.environmentKind,
          environmentName: runGroup.environmentName,
          ref: runGroup.ref,
          headSha: runGroup.headSha,
          trigger: runGroup.trigger,
          createdAt: runGroup.createdAt.toISOString(),
          startedAt: runGroup.startedAt?.toISOString() ?? null,
          completedAt: runGroup.completedAt?.toISOString() ?? null,
        },
        lifecycle: lifecycleState
          ? {
              run: {
                id: lifecycleState.run.id,
                status: lifecycleState.run.status,
                executionMode: lifecycleState.run.executionMode,
                startedAt: lifecycleState.run.startedAt.toISOString(),
                finishedAt: lifecycleState.run.finishedAt?.toISOString() ?? null,
              },
              items: lifecycleState.items.map((item) => ({
                id: item.id,
                workspacePath: item.workspacePath,
                key: item.key,
                phase: item.phase,
                state: item.state,
                failurePolicy: item.failurePolicy,
                scopes: item.scopes,
                summary: item.summary,
                reason: item.reason,
                startedAt: item.startedAt?.toISOString() ?? null,
                finishedAt: item.finishedAt?.toISOString() ?? null,
                events: lifecycleEvents
                  .filter((event) => event.itemId === item.id)
                  .map((event) => ({
                    id: event.id,
                    eventType: event.eventType,
                    payload: event.payload,
                    createdAt: event.createdAt.toISOString(),
                  })),
              })),
            }
          : null,
        deployments: deployments.map((deployment) => {
          const latestRun = latestRuns.get(deployment.id)?.[0] ?? null
          return {
            id: deployment.id,
            workspacePath: deployment.workspacePath,
            status: deployment.status,
            latestRun: latestRun
              ? {
                  id: latestRun.id,
                  runType: latestRun.runType,
                  status: latestRun.status,
                  planSummary: latestRun.planSummary,
                  errorMessage: latestRun.errorMessage,
                  createdAt: latestRun.createdAt.toISOString(),
                  startedAt: latestRun.startedAt?.toISOString() ?? null,
                  completedAt: latestRun.completedAt?.toISOString() ?? null,
                }
              : null,
          }
        }),
      },
    })
  })

  return route
}
const enforceFeatureToken: MiddlewareHandler = async (c, next) => {
  const expectedToken = process.env[LOCAL_FIRST_FEATURE_TOKEN_ENV_VAR]?.trim()
  if (!expectedToken) {
    return c.json({ error: { code: "NOT_FOUND", message: "not found" } }, 404)
  }

  const providedToken = c.req.header("feature-token")?.trim() ?? ""
  if (!featureTokenMatches(expectedToken, providedToken)) {
    return c.json(
      { error: { code: "INVALID_FEATURE_TOKEN", message: "invalid feature token" } },
      403,
    )
  }

  return next()
}

function featureTokenMatches(expectedToken: string, providedToken: string): boolean {
  if (!expectedToken || !providedToken) {
    return false
  }

  const expected = Buffer.from(expectedToken)
  const provided = Buffer.from(providedToken)
  if (expected.length !== provided.length) {
    return false
  }

  return timingSafeEqual(expected, provided)
}

function hasMinRole(role: string, minRole: "viewer" | "approver" | "admin"): boolean {
  const levels: Record<string, number> = {
    viewer: 1,
    approver: 2,
    admin: 3,
  }
  return (levels[role] ?? 0) >= levels[minRole]
}

function isPaidCloudOrg(planTier: string, subscriptionStatus: string): boolean {
  if (subscriptionStatus === "canceled" || subscriptionStatus === "unpaid") {
    return false
  }
  return planTier !== "free"
}

function buildManualWebhookContext(input: {
  repoFullName: string
  installationId: number
  repoGithubId: number
  defaultBranch: string
  environmentName: string
  ref: string
  headSha: string
}): WebhookContext {
  const [owner, repo] = input.repoFullName.split("/")
  if (!owner || !repo) {
    throw new Error(`Invalid repo full name '${input.repoFullName}'`)
  }

  const prNumber = parsePrEnvironmentName(input.environmentName)
  if (prNumber != null) {
    return {
      kind: "pull_request",
      installationId: input.installationId,
      repoGithubId: input.repoGithubId,
      ownerGithubId: 0,
      owner,
      repo,
      prNumber,
      action: "synchronize",
      headSha: input.headSha,
      branch: stripBranchRef(input.ref),
      authorGithubId: 0,
      authorLogin: "manual",
      merged: false,
      defaultBranch: input.defaultBranch,
    } satisfies PullRequestContext
  }

  return {
    kind: "push",
    installationId: input.installationId,
    repoGithubId: input.repoGithubId,
    ownerGithubId: 0,
    owner,
    repo,
    headSha: input.headSha,
    ref: input.ref,
    refType: input.ref.startsWith("refs/tags/") ? "tag" : "branch",
    refName: stripGitRef(input.ref),
    pusherGithubId: null,
    pusherLogin: "manual",
    defaultBranch: input.defaultBranch,
  } satisfies PushContext
}

function environmentMatchesRef(config: YaffleTomlConfig, ctx: WebhookContext, environmentName: string): boolean {
  if (ctx.kind === "pull_request") {
    return matchesPullRequestTrigger(config, ctx.branch)
  }

  return findPushTriggerEnvironment(config, ctx.ref) === environmentName
}

function stripBranchRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, "")
}

function stripGitRef(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, "")
}

function deriveCloudConvergeRunGroupStatus(
  runGroupStatus: string,
  lifecycleStatus: string | undefined,
): string {
  if (!lifecycleStatus) {
    return runGroupStatus
  }

  if (runGroupStatus === "failed") {
    return "failed"
  }

  if (lifecycleStatus === "running") {
    return "running"
  }

  if (lifecycleStatus === "failed") {
    return "failed"
  }

  if (lifecycleStatus === "degraded") {
    return "partial"
  }

  return runGroupStatus
}

async function loadConfigFromGithub(ctx: WebhookContext): Promise<YaffleTomlConfig> {
  const raw = await fetchFileContent(
    ctx.installationId,
    ctx.owner,
    ctx.repo,
    "yaffle.toml",
    ctx.headSha,
  )
  if (!raw) {
    throw new Error("No yaffle.toml found in repository")
  }
  return parseYaffleToml(raw)
}

async function dispatchManualScan(input: {
  ctx: WebhookContext
  orgId: string
  orgSlug: string
  runGroupId: string
  workspacePaths: string[]
  workspaceVariables: WorkspaceVariablesByPath
  installationToken: string
}): Promise<{ scanJobId: string }> {
  const scanJob = await createScanJob({
    runGroupId: input.runGroupId,
    orgId: input.orgId,
    repoUrl: `https://github.com/${input.ctx.owner}/${input.ctx.repo}.git`,
    ref: input.ctx.kind === "pull_request" ? `refs/heads/${input.ctx.branch}` : input.ctx.ref,
    headSha: input.ctx.headSha,
    installationToken: input.installationToken,
    orgSlug: input.orgSlug,
    workspacePaths: input.workspacePaths,
    workspaceVariables: input.workspaceVariables,
  })

  const scanToken = await generateScanJobToken(scanJob.id, input.orgId)
  const { updateRunGroupStatus } = await import("../db/queries/run-groups.ts")
  await updateRunGroupStatus(input.runGroupId, "scanning")

  const lambdaFunction = process.env.YAFFLE_SCANNER_LAMBDA_FUNCTION
  if (lambdaFunction) {
    const { LambdaScannerSpawner } = await import("../lib/lambda-scanner-spawner.ts")
    const lambdaSpawner = new LambdaScannerSpawner({
      functionName: lambdaFunction,
      region: process.env.AWS_REGION ?? "us-east-1",
      apiUrl: process.env.YAFFLE_RUNNER_API_URL!,
    })
    await lambdaSpawner.spawnScanner(scanJob.id, scanToken)
  } else {
    const scheduler = await getScheduler()
    await scheduler.spawner.spawnScanner(scanJob.id, scanToken)
  }

  return { scanJobId: scanJob.id }
}

export const cloudConvergeRoute = createCloudConvergeRoute()
