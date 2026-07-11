import { Hono, type MiddlewareHandler } from "hono"
import { timingSafeEqual } from "node:crypto"
import { z } from "zod"

import type { PushContext, WebhookContext } from "@yaffle/shared"

import { createRunGroup, findRunGroupById } from "../db/queries/run-groups.ts"
import { findRunById, listRunsForDeployments } from "../db/queries/tf-runs.ts"
import {
  findDeploymentsByRunGroup,
  listLatestDeploymentsForOrg,
} from "../db/queries/workspace-deployments.ts"
import { listEnvironmentGroupProjections } from "../db/queries/environment-group-projections.ts"
import { ensurePrincipalRepoBinding } from "../db/queries/principals.ts"
import {
  getLifecycleStateForRunGroup,
  listLifecycleEventsForItems,
} from "../db/queries/lifecycle.ts"
import { findOrgById, findOrgMembership } from "../db/queries/organizations.ts"
import { findRepoByFullName } from "../db/queries/repositories.ts"
import { findUserById } from "../db/queries/users.ts"
import {
  getAutomaticIsolationWorkspacePaths,
  getEnvironmentKind,
  parseYaffleToml,
  type YaffleTomlConfig,
} from "../lib/config-toml.ts"
import {
  parseEnvironmentGroupProjectionPayload,
  type EnvironmentGroupProjectionPayload,
} from "../lib/projections/environment-groups.ts"
import {
  findPushTriggerEnvironment,
  getWorkspacesForEnvironment,
  matchesPullRequestTrigger,
} from "../lib/config-toml.ts"
import { getEnv } from "../lib/env.ts"
import { fetchFileContent, getInstallationToken } from "../lib/github.ts"
import {
  deriveLifecycleConditions,
  deriveRunGroupLifecycleState,
  deriveWorkspaceLifecycleState,
} from "../lib/lifecycle-conditions.ts"
import { logger } from "../lib/telemetry.ts"
import {
  buildWorkspaceVariablesByPath,
  type WorkspaceVariablesByPath,
} from "../lib/workspace-variables.ts"
import { principalAuth, type PrincipalAuthContext } from "../middleware/principal-auth.ts"
import {
  createScanJob,
  findLatestScanJobByRunGroup,
  type ScanJobResult,
} from "../db/queries/scan-jobs.ts"
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
  automaticIsolationWorkspacePaths: string[]
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
  workspacePaths: z.array(z.string().min(1)).default([]),
})

const capabilitiesQuerySchema = z.object({
  repoFullName: z.string().min(1),
})

const inventoryQuerySchema = z.object({
  repoFullName: z.string().min(1),
})

const uuidParam = z.string().uuid()

export function createCloudConvergeRoute(
  deps: {
    loadConfig?: ConfigLoader
    loadInstallationToken?: InstallationTokenLoader
    scanDispatcher?: ScanDispatcher
  } = {},
): Hono<{ Variables: Variables }> {
  const route = new Hono<{ Variables: Variables }>()
  const loadConfig = deps.loadConfig ?? loadConfigFromGithub
  const loadInstallationToken = deps.loadInstallationToken ?? getInstallationToken
  const scanDispatcher = deps.scanDispatcher ?? dispatchManualScan

  route.use("/converge", enforceFeatureToken)
  route.use("/converge/*", enforceFeatureToken)
  route.use("/capabilities", enforceFeatureToken)
  route.use("/inventory", enforceFeatureToken)
  route.use("/converge", principalAuth())
  route.use("/converge/*", principalAuth())
  route.use("/capabilities", principalAuth())
  route.use("/inventory", principalAuth())

  route.get("/capabilities", async (c) => {
    const principal = c.get("principalAuth")
    const parsed = capabilitiesQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    )
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "BAD_REQUEST",
            message: parsed.error.errors[0]?.message ?? "invalid request",
          },
        },
        400,
      )
    }

    const values = parsed.data
    if (principal.type !== "account" || !principal.userId) {
      return c.json({
        data: remoteConvergeCapabilityUnavailable({
          principalType: principal.type,
          repoFullName: values.repoFullName,
          principalTier: "anonymous",
          reasonCode: "ACCOUNT_REQUIRED",
          message: "sign in to use Yaffle Cloud for this repository",
        }),
      })
    }

    const repo = await findRepoByFullName(values.repoFullName)
    if (!repo?.orgId || !repo.installationId) {
      return c.json({
        data: remoteConvergeCapabilityUnavailable({
          principalType: principal.type,
          repoFullName: values.repoFullName,
          principalTier: "free_local",
          reasonCode: "REPO_NOT_CONNECTED",
          message: "connect this repository to Yaffle Cloud to see hosted environments here",
        }),
      })
    }

    const org = await findOrgById(repo.orgId)
    if (!org) {
      return c.json({
        data: remoteConvergeCapabilityUnavailable({
          principalType: principal.type,
          repoFullName: values.repoFullName,
          principalTier: "free_local",
          reasonCode: "ORG_NOT_FOUND",
          message: "connect this repository to Yaffle Cloud to see hosted environments here",
        }),
      })
    }

    const membership = await findOrgMembership(org.id, principal.userId)
    if (!membership || !hasMinRole(membership.role, "approver")) {
      return c.json({
        data: remoteConvergeCapabilityUnavailable({
          principalType: principal.type,
          repoFullName: values.repoFullName,
          principalTier: "free_local",
          reasonCode: "FORBIDDEN",
          message: "ask an org admin for access to this repository",
        }),
      })
    }

    if (!isPaidCloudOrg(org.planTier, org.subscriptionStatus)) {
      return c.json({
        data: remoteConvergeCapabilityUnavailable({
          principalType: principal.type,
          repoFullName: values.repoFullName,
          principalTier: "free_local",
          reasonCode: "PAID_CLOUD_REQUIRED",
          message: "upgrade to paid cloud",
          upgradeUrl: `/${org.slug}/settings/billing`,
        }),
      })
    }

    return c.json({
      data: {
        principalType: principal.type,
        repoFullName: values.repoFullName,
        executionMode: "remote",
        principalTier: "paid_cloud",
        remoteConverge: {
          available: true,
          reasonCode: null,
          message: "paid cloud is active for this repository",
          upgradeUrl: null,
        },
      },
    })
  })

  route.get("/inventory", async (c) => {
    const principal = c.get("principalAuth")
    if (principal.type !== "account" || !principal.userId) {
      return c.json(
        {
          error: {
            code: "ACCOUNT_REQUIRED",
            message: "cloud inventory requires an account-backed CLI session",
          },
        },
        403,
      )
    }

    const parsed = inventoryQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    )
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "BAD_REQUEST",
            message: parsed.error.errors[0]?.message ?? "invalid request",
          },
        },
        400,
      )
    }

    const { repoFullName } = parsed.data
    const repo = await findRepoByFullName(repoFullName)
    if (!repo?.orgId) {
      return c.json(
        { error: { code: "REPO_NOT_FOUND", message: `repository not found: ${repoFullName}` } },
        404,
      )
    }

    const membership = await findOrgMembership(repo.orgId, principal.userId)
    if (!membership || !hasMinRole(membership.role, "viewer")) {
      return c.json({ error: { code: "FORBIDDEN", message: "cloud inventory access denied" } }, 403)
    }

    const [rows, latestDeployments] = await Promise.all([
      listEnvironmentGroupProjections({
        orgId: repo.orgId,
        repo: repo.name,
      }),
      listLatestDeploymentsForOrg(repo.orgId),
    ])
    const activeRunGroupIds = activeRunGroupIdsFromDeployments(
      latestDeployments.filter((deployment) => deployment.repo === repo.name),
    )
    const environments = (
      await Promise.all(
        rows.map(async (row) => {
          const payload = parseEnvironmentGroupProjectionPayload(row.payload)
          if (!payload) {
            return null
          }
          const activeRunGroupId =
            activeRunGroupIds.get(
              environmentGroupKey({
                repo: payload.repo,
                environmentKind: payload.environmentKind,
                environmentName: payload.environmentName,
              }),
            ) ?? (await activeRunGroupIdFromPayload(payload))

          return {
            repo: payload.repo,
            environmentKind: payload.environmentKind,
            environmentName: payload.environmentName,
            sourceKind: payload.sourceKind,
            status: environmentInventoryStatus(payload.status, payload.workspaces),
            activeRunGroupId,
            ref: payload.ref,
            headSha: payload.headSha,
            updatedAt: payload.updatedAt,
            workspaceCount: payload.workspaces.length,
            statusVector: workspaceStatusVector(payload.workspaces),
            prNumber: payload.sourceMetadata?.prNumber ?? null,
            actorLogin:
              payload.sourceMetadata?.authorLogin ?? latestWorkspaceAuthor(payload.workspaces),
          }
        }),
      )
    ).filter((environment): environment is NonNullable<typeof environment> => environment !== null)

    return c.json({
      data: {
        repoFullName,
        environments,
      },
    })
  })

  route.post("/converge", async (c) => {
    const principal = c.get("principalAuth")
    if (principal.type !== "account" || !principal.userId) {
      return c.json(
        {
          error: {
            code: "PAID_CLOUD_REQUIRED",
            message: "paid cloud converge requires an account session",
          },
        },
        403,
      )
    }

    const body = await c.req.json().catch(() => null)
    const parsed = manualConvergeSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "BAD_REQUEST",
            message: parsed.error.errors[0]?.message ?? "invalid request",
          },
        },
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
      return c.json(
        {
          error: {
            code: "REPO_NOT_FOUND",
            message: `repository not found: ${values.repoFullName}`,
          },
        },
        404,
      )
    }
    if (!repo.installationId) {
      return c.json(
        {
          error: {
            code: "REPO_NOT_CONNECTED",
            message: `repository ${values.repoFullName} is not connected to a GitHub App installation`,
          },
        },
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
        {
          error: {
            code: "FORBIDDEN",
            message: "paid cloud converge requires approver role or higher",
          },
        },
        403,
      )
    }
    if (!isPaidCloudOrg(org.planTier, org.subscriptionStatus)) {
      return c.json(
        {
          error: {
            code: "PAID_CLOUD_REQUIRED",
            message: "paid cloud converge requires an active plan",
          },
        },
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
      ref: values.ref,
      headSha: values.headSha,
    })
    const config = await loadConfig(ctx)
    const environmentKind = getEnvironmentKind(config, values.environmentName)

    if (environmentKind === "named" && !environmentMatchesRef(config, ctx, values.environmentName)) {
      return c.json(
        {
          error: {
            code: "TARGET_MISMATCH",
            message: `ref '${values.ref}' does not match environment '${values.environmentName}'`,
          },
        },
        400,
      )
    }

    const eligibleWorkspacePathsInOrder = getWorkspacesForEnvironment(
      config,
      values.environmentName,
      environmentKind === "transient",
    )
    const eligibleWorkspacePaths = new Set(eligibleWorkspacePathsInOrder)
    const requestedWorkspacePaths = [...new Set(values.workspacePaths)]
    const selectedWorkspacePaths =
      requestedWorkspacePaths.length > 0 ? requestedWorkspacePaths : eligibleWorkspacePathsInOrder
    const invalidWorkspacePaths = requestedWorkspacePaths.filter(
      (workspacePath) => !eligibleWorkspacePaths.has(workspacePath),
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
      environmentKind,
    )
    const automaticIsolationWorkspacePaths = getAutomaticIsolationWorkspacePaths(
      config,
      selectedWorkspacePaths,
      environmentKind,
    )

    const actor = await findUserById(principal.userId)
    const runGroup = await createRunGroup({
      orgId: org.id,
      repoBindingId: repoBinding.id,
      repo: repo.name,
      environmentKind,
      environmentName: values.environmentName,
      prNumber: null,
      ref: values.ref,
      headSha: values.headSha,
      selectedWorkspacePaths: selectedWorkspacePaths,
      trigger: "manual",
      triggeredByUserId: principal.userId,
      triggeredByLogin: actor?.name ?? actor?.email ?? null,
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
      automaticIsolationWorkspacePaths,
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
          webUrl: buildCloudRunGroupWebUrl(org.slug, repo.name, values.environmentName),
          status: "queued",
        },
      },
      202,
    )
  })

  route.get("/converge/:runGroupId", async (c) => {
    const principal = c.get("principalAuth")
    if (!principal) {
      return c.json({ error: { code: "AUTH_REQUIRED", message: "authentication required" } }, 401)
    }
    if (principal.type !== "account" || !principal.userId) {
      return c.json(
        {
          error: {
            code: "PAID_CLOUD_REQUIRED",
            message: "paid cloud converge requires an account session",
          },
        },
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
      return c.json({ error: { code: "FORBIDDEN", message: "run group access denied" } }, 403)
    }

    const deployments = await findDeploymentsByRunGroup(runGroup.id)
    const latestRuns = await listRunsForDeployments(deployments.map((deployment) => deployment.id))
    const lifecycleState = await getLifecycleStateForRunGroup(runGroup.id)
    const lifecycleEvents = await listLifecycleEventsForItems(
      lifecycleState?.items.map((item) => item.id) ?? [],
    )
    const lifecycleItems = lifecycleState?.items ?? []
    const scanJob = await findLatestScanJobByRunGroup(runGroup.id)
    const scanResult = scanJob?.result as ScanJobResult | null

    const serializedDeployments = await Promise.all(
      deployments.map(async (deployment) => {
        const serializedRuns = await Promise.all(
          (latestRuns.get(deployment.id) ?? []).slice(0, 5).map(async (run) => {
            const fullRun = await findRunById(run.id)
            return {
              id: run.id,
              runType: run.runType,
              status: run.status,
              planSummary: run.planSummary,
              errorMessage: run.errorMessage,
              logOutput: fullRun?.logOutput ?? null,
              createdAt: run.createdAt.toISOString(),
              startedAt: run.startedAt?.toISOString() ?? null,
              completedAt: run.completedAt?.toISOString() ?? null,
            }
          }),
        )
        const latestRun = serializedRuns[0] ?? null
        const workspaceLifecycleItems = lifecycleItems.filter(
          (item) => item.workspacePath === deployment.workspacePath,
        )
        const workspaceLifecycleState = deriveWorkspaceLifecycleState(
          workspaceLifecycleItems.map((item) => ({
            workspacePath: item.workspacePath,
            phase: item.phase,
            state: item.state,
            scopes: item.scopes,
          })),
        )
        return {
          id: deployment.id,
          workspacePath: deployment.workspacePath,
          status: deployment.status,
          lifecycle:
            workspaceLifecycleItems.length > 0
              ? {
                  deploymentStatus: workspaceLifecycleState.deploymentStatus,
                  conditions: serializeLifecycleConditions(workspaceLifecycleState.conditions),
                }
              : null,
          latestRun,
          runs: serializedRuns,
        }
      }),
    )

    const runGroupStatus = deriveCloudConvergeRunGroupStatus(
      runGroup.status,
      serializedDeployments.map((deployment) => ({
        workspacePath: deployment.workspacePath,
        status: deployment.status,
        latestRunStatus: deployment.latestRun?.status ?? null,
      })),
      lifecycleItems.map((item) => ({
        workspacePath: item.workspacePath,
        phase: item.phase,
        state: item.state,
        scopes: item.scopes,
      })),
    )

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
          selectedWorkspacePaths: (runGroup.selectedWorkspacePaths as string[] | null) ?? [],
          trigger: runGroup.trigger,
          createdAt: runGroup.createdAt.toISOString(),
          startedAt: runGroup.startedAt?.toISOString() ?? null,
          completedAt: runGroup.completedAt?.toISOString() ?? null,
        },
        automaticIsolationPreflight: scanResult?.automaticIsolationPreflight ?? null,
        lifecycle: lifecycleState
          ? {
              run: {
                id: lifecycleState.run.id,
                status: lifecycleState.run.status,
                executionMode: lifecycleState.run.executionMode,
                startedAt: lifecycleState.run.startedAt.toISOString(),
                finishedAt: lifecycleState.run.finishedAt?.toISOString() ?? null,
                conditions: serializeLifecycleConditions(
                  deriveLifecycleConditions(
                    lifecycleItems.map((item) => ({
                      workspacePath: item.workspacePath,
                      phase: item.phase,
                      state: item.state,
                      scopes: item.scopes,
                    })),
                  ),
                ),
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
        deployments: serializedDeployments,
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

function remoteConvergeCapabilityUnavailable(input: {
  principalType: "anonymous_session" | "account"
  repoFullName: string
  principalTier: "anonymous" | "free_local" | "paid_cloud"
  reasonCode: string
  message: string
  upgradeUrl?: string | null
}): {
  principalType: "anonymous_session" | "account"
  repoFullName: string
  executionMode: "local"
  principalTier: "anonymous" | "free_local" | "paid_cloud"
  remoteConverge: {
    available: false
    reasonCode: string
    message: string
    upgradeUrl: string | null
  }
} {
  return {
    principalType: input.principalType,
    repoFullName: input.repoFullName,
    executionMode: "local",
    principalTier: input.principalTier,
    remoteConverge: {
      available: false,
      reasonCode: input.reasonCode,
      message: input.message,
      upgradeUrl: input.upgradeUrl ?? null,
    },
  }
}

function workspaceStatusVector<T extends { status: string }>(
  workspaces: T[],
): Array<{ status: string; count: number }> {
  const counts = new Map<string, number>()
  for (const workspace of workspaces) {
    counts.set(workspace.status, (counts.get(workspace.status) ?? 0) + 1)
  }

  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => ({ status, count }))
}

function environmentInventoryStatus<T extends { status: string }>(
  status: string,
  workspaces: T[],
): string {
  const activeStatuses = new Set(["planning", "applying", "activating", "destroying", "running"])
  if (status === "in_progress" || activeStatuses.has(status)) {
    return "in_progress"
  }
  if (workspaces.some((workspace) => activeStatuses.has(workspace.status))) {
    return "in_progress"
  }

  return status
}

function activeRunGroupIdsFromDeployments(
  deployments: Array<{
    repo: string
    environmentKind: string
    environmentName: string
    status: string
    runGroupId: string | null
    statusChangedAt: Date
  }>,
): Map<string, string> {
  const activeStatuses = new Set(["planning", "applying", "activating", "destroying", "running"])
  const activeByEnvironment = new Map<string, { runGroupId: string; statusChangedAt: Date }>()

  for (const deployment of deployments) {
    if (!deployment.runGroupId || !activeStatuses.has(deployment.status)) {
      continue
    }

    const key = environmentGroupKey(deployment)
    const existing = activeByEnvironment.get(key)
    if (!existing || deployment.statusChangedAt > existing.statusChangedAt) {
      activeByEnvironment.set(key, {
        runGroupId: deployment.runGroupId,
        statusChangedAt: deployment.statusChangedAt,
      })
    }
  }

  return new Map([...activeByEnvironment.entries()].map(([key, value]) => [key, value.runGroupId]))
}

function environmentGroupKey(input: {
  repo: string
  environmentKind: string
  environmentName: string
}): string {
  return `${input.repo}:${input.environmentKind}:${input.environmentName}`
}

async function activeRunGroupIdFromPayload(
  payload: EnvironmentGroupProjectionPayload,
): Promise<string | null> {
  if (typeof payload.activeRunGroupId === "string" && payload.activeRunGroupId.length > 0) {
    return payload.activeRunGroupId
  }

  const activeStatuses = new Set(["planning", "applying", "activating", "destroying", "running"])
  const activeWorkspace = payload.workspaces
    .filter(
      (workspace) =>
        activeStatuses.has(workspace.status) || activeStatuses.has(workspace.lastRunStatus ?? ""),
    )
    .sort((left, right) => right.headUpdatedAt.localeCompare(left.headUpdatedAt))[0]

  if (!activeWorkspace?.lastRunId) {
    return null
  }

  const run = await findRunById(activeWorkspace.lastRunId)
  return run?.runGroupId ?? null
}

function latestWorkspaceAuthor<T extends { authorLogin: string | null }>(
  workspaces: T[],
): string | null {
  return workspaces.find((workspace) => workspace.authorLogin)?.authorLogin ?? null
}

function buildManualWebhookContext(input: {
  repoFullName: string
  installationId: number
  repoGithubId: number
  defaultBranch: string
  ref: string
  headSha: string
}): WebhookContext {
  const [owner, repo] = input.repoFullName.split("/")
  if (!owner || !repo) {
    throw new Error(`Invalid repo full name '${input.repoFullName}'`)
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

function environmentMatchesRef(
  config: YaffleTomlConfig,
  ctx: WebhookContext,
  environmentName: string,
): boolean {
  if (ctx.kind === "pull_request") {
    return matchesPullRequestTrigger(config, ctx.branch)
  }

  return findPushTriggerEnvironment(config, ctx.ref) === environmentName
}

function stripGitRef(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, "")
}

function deriveCloudConvergeRunGroupStatus(
  runGroupStatus: string,
  deployments: Array<{ workspacePath: string; status: string; latestRunStatus: string | null }>,
  lifecycleItems: Array<{ workspacePath: string; phase: string; state: string; scopes: string[] }>,
): string {
  if (
    deployments.some(
      (deployment) =>
        ["failed", "system_error"].includes(deployment.status) ||
        ["failed", "system_error", "cancelled"].includes(deployment.latestRunStatus ?? ""),
    )
  ) {
    return "failed"
  }

  if (deployments.length === 0 || lifecycleItems.length === 0) {
    return runGroupStatus
  }

  if (runGroupStatus === "failed") {
    return "failed"
  }

  return deriveRunGroupLifecycleState({
    deployments,
    items: lifecycleItems,
  }).status
}

function serializeLifecycleConditions(
  conditions: ReturnType<typeof deriveLifecycleConditions>,
): Array<{
  name: string
  met: boolean
  summary: string
  vector: {
    pending: number
    running: number
    succeeded: number
    degraded: number
    blocked: number
    failed: number
  }
}> {
  return Object.values(conditions)
}

function buildCloudRunGroupWebUrl(orgSlug: string, repo: string, environmentName: string): string {
  const baseUrl = getEnv().publicApiUrl.replace(/\/$/, "")
  return `${baseUrl}/app/${encodeURIComponent(orgSlug)}/${encodeURIComponent(repo)}/env/${encodeURIComponent(environmentName)}`
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
  automaticIsolationWorkspacePaths: string[]
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
    automaticIsolationWorkspacePaths: input.automaticIsolationWorkspacePaths,
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
