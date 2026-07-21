import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"

import { findDeploymentsByEnvironment } from "../db/queries/workspace-deployments.ts"
import { findEnvironmentPolicy } from "../db/queries/environment-policies.ts"
import {
  type LifecycleEvent,
  type LifecycleItem,
  type LifecycleRun,
  getLifecycleStateForRunGroup,
  getLatestLifecycleStateForRepoEnvironment,
  listLifecycleEventsForItems,
} from "../db/queries/lifecycle.ts"
import { findRepoByName } from "../db/queries/repositories.ts"
import {
  listRunsForPreview,
  listRunsForDeployments,
  findLatestSuccessfulRun,
  findLatestSuccessfulRunsForDeployments,
  type TfRunListItem,
} from "../db/queries/tf-runs.ts"
import { getSpansForRun } from "../db/queries/resource-spans.ts"
import { listConnectionsForOrg } from "../db/queries/connections.ts"
import { findRunGroupWorkspaceMetadataForRunGroups } from "../db/queries/run-group-workspace-metadata.ts"
import { findPrincipalRepoBindingById } from "../db/queries/principals.ts"
import {
  listRunGroupsForPr,
  listRunGroupsForBranch,
  listRunGroupsForEnvironment,
  type RunGroup,
} from "../db/queries/run-groups.ts"
import { requireOrgAccess, getAuth, type OrgAuthContext } from "../middleware/org-auth.ts"
import {
  events,
  type DeploymentUpdateEvent,
  type JobUpdateEvent,
  type RunUpdateEvent,
} from "../lib/events.ts"
import { buildPrEnvironmentName } from "../lib/config-toml.ts"
import {
  getSseSnapshotDurationHistogram,
  getSseEventToSendLatencyHistogram,
  getSsePayloadBytesHistogram,
  getSseMessagesSentCounter,
  getSseMessagesDedupedCounter,
  getSseConnectionsActiveCounter,
  logger,
} from "../lib/telemetry.ts"
import {
  formatConnectionBlockedReason,
  getConnectionReadinessForDeployment,
  getConnectionReadinessForDeploymentWithDeps,
  type WorkspaceDegradation,
} from "../lib/execution-credentials.ts"
import {
  getRequiredProviderRequirementsForDeployment,
  getRequiredProvidersForDeployment,
} from "../lib/provider-requirements.ts"
import {
  buildStreamPayloadMeta,
  createStreamContext,
  parseRunViewCorrelation,
  runViewCorrelationQueryFields,
} from "../lib/run-view-monitoring.ts"
import {
  findExecutionSnapshotWorkspace,
  isExecutionContextAssociationValid,
  serializeBoundExecutionSnapshotIdentity,
} from "../lib/execution-snapshot.ts"
import { selectTerraformOutputs } from "../lib/output-selection.ts"
import type { WorkspaceOutputPolicy } from "../lib/config-toml.ts"

const prNumberParam = z.coerce.number().int().positive()
const environmentQuerySchema = z.object({
  head_sha: z.string().min(7).max(64).optional(),
  view: z.enum(["full", "dag"]).optional(),
  output_audience: z.enum(["viewer", "automation"]).optional(),
  ...runViewCorrelationQueryFields,
})
const runViewTelemetryEventSchema = z.object({
  name: z.enum([
    "run_view_opened",
    "run_view_first_dag_rendered",
    "run_view_selected_workspace_rendered",
    "run_view_no_data_flash",
    "run_view_stale_status_flash",
    "run_view_new_run_detected",
    "run_view_new_run_handoff_rendered",
    "run_view_env_snapshot_applied",
    "run_view_env_stream_reconnected",
    "run_view_log_stream_reconnected",
    "run_view_terminal_first_log_byte",
    "run_view_terminal_stall_started",
    "run_view_terminal_stall_ended",
    "run_view_long_task",
  ]),
  occurredAt: z.string().datetime(),
  runViewSessionId: z.string().uuid().nullable(),
  pageViewId: z.string().uuid().nullable(),
  runGroupId: z.string().uuid().nullable().optional(),
  runId: z.string().uuid().nullable().optional(),
  workspacePath: z.string().min(1).max(512).nullable().optional(),
  runType: z.string().min(1).max(32).nullable().optional(),
  durationMs: z.number().finite().nonnegative().max(600_000).optional(),
  workspaceCount: z.number().int().nonnegative().max(10_000).optional(),
  affectedWorkspaceCount: z.number().int().nonnegative().max(10_000).optional(),
  usedPlaceholderDag: z.boolean().optional(),
  selectionSource: z.enum(["initial", "manual"]).optional(),
  surface: z.enum(["page", "tab"]).optional(),
  streamType: z.enum(["environment", "run_log"]).optional(),
  sourceEventType: z.string().min(1).max(64).nullable().optional(),
  sourceEventAt: z.string().datetime().nullable().optional(),
  sentAt: z.string().datetime().nullable().optional(),
  freshnessMs: z.number().finite().nonnegative().max(600_000).optional(),
  transportMs: z.number().finite().nonnegative().max(600_000).optional(),
  clientApplyMs: z.number().finite().nonnegative().max(600_000).optional(),
  reconnectCount: z.number().int().nonnegative().max(1_000).optional(),
  stallThresholdMs: z.number().finite().nonnegative().max(600_000).optional(),
  connectionState: z.string().min(1).max(64).nullable().optional(),
  isVisible: z.boolean().optional(),
})
const runViewTelemetryBatchSchema = z.object({
  events: z.array(runViewTelemetryEventSchema).min(1).max(20),
})

export const reposRoute = new Hono()

// ---------------------------------------------------------------------------
// PR Routes - /api/orgs/:org/repos/:repo/pr/:prNumber
// ---------------------------------------------------------------------------

/**
 * GET /api/orgs/:org/repos/:repo/pr/:prNumber
 *
 * Get all previews (workspaces) for a PR.
 */
reposRoute.get(
  "/:org/repos/:repo/pr/:prNumber",
  requireOrgAccess({ orgSource: "param", orgKey: "org" }),
  async (c) => {
    const auth = getAuth(c)
    const repo = c.req.param("repo")
    if (!repo) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "repo is required" } }, 400)
    }

    const prParsed = prNumberParam.safeParse(c.req.param("prNumber"))
    if (!prParsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "prNumber must be a positive integer" } },
        400,
      )
    }
    const prNumber = prParsed.data

    const environmentName = buildPrEnvironmentName(prNumber)
    const deployments = await findDeploymentsByEnvironment(auth.orgId, repo, environmentName)
    const runGroupsData = await listRunGroupsForPr(auth.orgId, repo, prNumber)

    if (deployments.length === 0) {
      if (runGroupsData.length === 0) {
        return c.json(
          { error: { code: "NOT_FOUND", message: `no previews found for PR #${prNumber}` } },
          404,
        )
      }

      const latestRunGroup = runGroupsData[0]
      return c.json({
        data: {
          org: c.req.param("org"),
          repo,
          prNumber,
          ref: latestRunGroup.ref,
          headSha: latestRunGroup.headSha,
          authorGithubId: null,
          authorLogin: null,
          workspaces: [],
          runGroups: await serializeRunGroups(runGroupsData),
        },
      })
    }

    // Fetch runs for each deployment
    const deploymentsWithRuns = await Promise.all(
      deployments.map(async (deployment) => {
        const runs = await listRunsForPreview(deployment.id)
        const latestApply = await findLatestSuccessfulRun(deployment.id, "apply")
        const outputAudience = outputAudienceForAuth(auth)
        const outputs = selectEnvironmentOutputs(latestApply?.outputs, outputAudience, {})
        const connectionReadiness = await getConnectionReadinessForDeployment(deployment)
        return {
          preview: serializePreview(deployment, connectionReadiness),
          runs: runs.map((run) => serializeRun(run, outputAudience, {})),
          outputs,
        }
      }),
    )

    // Get metadata from first deployment
    const first = deployments[0]

    return c.json({
      data: {
        org: c.req.param("org"),
        repo,
        prNumber,
        ref: first.ref,
        headSha: first.headSha,
        authorGithubId: first.authorGithubId,
        authorLogin: first.authorLogin,
        workspaces: deploymentsWithRuns,
        runGroups: await serializeRunGroups(runGroupsData),
      },
    })
  },
)

/**
 * GET /api/orgs/:org/repos/:repo/pr/:prNumber/stream
 *
 * SSE stream for PR updates (all workspaces).
 */
reposRoute.get(
  "/:org/repos/:repo/pr/:prNumber/stream",
  requireOrgAccess({ orgSource: "param", orgKey: "org" }),
  async (c) => {
    const auth = getAuth(c)
    const repo = c.req.param("repo")
    if (!repo) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "repo is required" } }, 400)
    }

    const prParsed = prNumberParam.safeParse(c.req.param("prNumber"))
    if (!prParsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "prNumber must be a positive integer" } },
        400,
      )
    }
    const prNumber = prParsed.data

    const environmentName = buildPrEnvironmentName(prNumber)

    return streamSSE(c, async (stream) => {
      getSseConnectionsActiveCounter().add(1, { type: "pr" })
      let lastPayload = ""
      let inFlight = false
      let pendingUpdate = false

      const sendSnapshot = async (): Promise<void> => {
        // If already fetching, mark that we need another update after
        if (inFlight) {
          pendingUpdate = true
          return
        }
        inFlight = true
        pendingUpdate = false

        try {
          const startTime = performance.now()
          const deployments = await findDeploymentsByEnvironment(auth.orgId, repo, environmentName)
          const runGroupsData = await listRunGroupsForPr(auth.orgId, repo, prNumber)

          if (deployments.length === 0) {
            const emptyPayload =
              runGroupsData.length === 0
                ? JSON.stringify({ data: null })
                : JSON.stringify({
                    data: {
                      org: c.req.param("org"),
                      repo,
                      prNumber,
                      ref: runGroupsData[0]?.ref ?? `refs/heads/pr-${prNumber}`,
                      headSha: runGroupsData[0]?.headSha ?? "",
                      authorGithubId: null,
                      authorLogin: null,
                      workspaces: [],
                      runGroups: await serializeRunGroups(runGroupsData),
                    },
                  })
            if (emptyPayload !== lastPayload) {
              lastPayload = emptyPayload
              await stream.writeSSE({ event: "update", data: emptyPayload })
            }
            return
          }

          const deploymentsWithRuns = await Promise.all(
            deployments.map(async (deployment) => {
              const runs = await listRunsForPreview(deployment.id)
              const latestApply = await findLatestSuccessfulRun(deployment.id, "apply")
              const outputAudience = outputAudienceForAuth(auth)
              const outputs = selectEnvironmentOutputs(latestApply?.outputs, outputAudience, {})
              const connectionReadiness = await getConnectionReadinessForDeployment(deployment)

              // Include resource spans for running deployments
              const isRunning =
                deployment.status === "planning" ||
                deployment.status === "applying" ||
                deployment.status === "destroying"
              const runningRun = isRunning ? runs.find((r) => r.status === "running") : null
              const resourceSpans = runningRun
                ? (await getSpansForRun(runningRun.id)).map(serializeResourceSpan)
                : undefined

              return {
                preview: serializePreview(deployment, connectionReadiness),
                runs: runs.map((run) => serializeRun(run, outputAudience, {})),
                outputs,
                ...(resourceSpans ? { resourceSpans } : {}),
              }
            }),
          )

          const queryDuration = performance.now() - startTime
          getSseSnapshotDurationHistogram().record(queryDuration, {
            type: "pr",
            workspace_count: String(deploymentsWithRuns.length),
          })

          const first = deployments[0]
          const payload = JSON.stringify({
            data: {
              org: c.req.param("org"),
              repo,
              prNumber,
              ref: first.ref,
              headSha: first.headSha,
              authorGithubId: first.authorGithubId,
              authorLogin: first.authorLogin,
              workspaces: deploymentsWithRuns,
              runGroups: await serializeRunGroups(runGroupsData),
            },
          })

          if (payload !== lastPayload) {
            lastPayload = payload
            getSsePayloadBytesHistogram().record(payload.length, { type: "pr" })
            getSseMessagesSentCounter().add(1, { type: "snapshot" })
            await stream.writeSSE({ event: "update", data: payload })
          } else {
            getSseMessagesDedupedCounter().add(1, { type: "pr" })
          }
        } finally {
          inFlight = false
          // If updates came in while we were fetching, fetch again
          if (pendingUpdate) {
            await sendSnapshot()
          }
        }
      }

      // Send initial snapshot
      await sendSnapshot()

      // Track deployment IDs for this PR to filter events
      let deploymentIds = new Set<string>()
      const updateDeploymentIds = async (): Promise<void> => {
        const deployments = await findDeploymentsByEnvironment(auth.orgId, repo, environmentName)
        deploymentIds = new Set(deployments.map((d) => d.id))
      }
      await updateDeploymentIds()

      // Listen for deployment updates matching this environment
      const handleDeploymentUpdate = (event: DeploymentUpdateEvent): void => {
        if (
          event.orgId === auth.orgId &&
          event.repo === repo &&
          event.environmentName === environmentName
        ) {
          updateDeploymentIds()
            .then(() => sendSnapshot())
            .catch((err) => console.error(`[sse:pr] error in handleDeploymentUpdate:`, err))
        }
      }

      // Listen for run updates for any deployment in this PR
      const handleRunUpdate = (event: RunUpdateEvent): void => {
        if (deploymentIds.has(event.deploymentId)) {
          sendSnapshot().catch((err) => console.error(`[sse:pr] error in handleRunUpdate:`, err))
        }
      }

      const handleJobUpdate = (event: JobUpdateEvent): void => {
        if (deploymentIds.has(event.deploymentId)) {
          sendSnapshot().catch((err) => console.error(`[sse:pr] error in handleJobUpdate:`, err))
        }
      }

      events.onDeploymentUpdate(handleDeploymentUpdate)
      events.onRunUpdate(handleRunUpdate)
      events.onJobUpdate(handleJobUpdate)

      // Heartbeat to keep connection alive
      const heartbeat = setInterval(() => {
        stream
          .writeSSE({ event: "heartbeat", data: JSON.stringify({ ts: Date.now() }) })
          .catch(() => {
            /* connection likely closed */
          })
      }, 30_000)

      // Block the callback so Hono doesn't call stream.close() in its
      // finally block.  The promise resolves only when the client
      // disconnects and onAbort fires, which lets cleanup run first.
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          getSseConnectionsActiveCounter().add(-1, { type: "pr" })
          clearInterval(heartbeat)
          events.offDeploymentUpdate(handleDeploymentUpdate)
          events.offRunUpdate(handleRunUpdate)
          events.offJobUpdate(handleJobUpdate)
          resolve()
        })
      })
    })
  },
)

// ---------------------------------------------------------------------------
// Environment Routes - /api/orgs/:org/repos/:repo/env/:branch
// ---------------------------------------------------------------------------

/**
 * GET /api/orgs/:org/repos/:repo/env/:branch
 *
 * Get all previews (workspaces) for a long-lived environment.
 */
reposRoute.get(
  "/:org/repos/:repo/env/:branch",
  requireOrgAccess({ orgSource: "param", orgKey: "org" }),
  async (c) => {
    const auth = getAuth(c)
    const repo = c.req.param("repo")
    const branch = c.req.param("branch")
    if (!repo || !branch) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "repo and branch are required" } },
        400,
      )
    }

    // For legacy env routes, branch name is the environment name
    const deployments = await findDeploymentsByEnvironment(auth.orgId, repo, branch)
    const runGroupsData = await listRunGroupsForBranch(auth.orgId, repo, branch)

    if (deployments.length === 0) {
      if (runGroupsData.length === 0) {
        return c.json(
          { error: { code: "NOT_FOUND", message: `no previews found for branch ${branch}` } },
          404,
        )
      }

      const latestRunGroup = runGroupsData[0]
      return c.json({
        data: {
          org: c.req.param("org"),
          repo,
          branch,
          headSha: latestRunGroup.headSha,
          workspaces: [],
          runGroups: await serializeRunGroups(runGroupsData),
        },
      })
    }

    // Fetch runs for each deployment
    const deploymentsWithRuns = await Promise.all(
      deployments.map(async (deployment) => {
        const runs = await listRunsForPreview(deployment.id)
        const latestApply = await findLatestSuccessfulRun(deployment.id, "apply")
        const outputAudience = outputAudienceForAuth(auth)
        const outputs = selectEnvironmentOutputs(latestApply?.outputs, outputAudience, {})
        const connectionReadiness = await getConnectionReadinessForDeployment(deployment)
        return {
          preview: serializePreview(deployment, connectionReadiness),
          runs: runs.map((run) => serializeRun(run, outputAudience, {})),
          outputs,
        }
      }),
    )

    const first = deployments[0]

    return c.json({
      data: {
        org: c.req.param("org"),
        repo,
        branch,
        headSha: first.headSha,
        workspaces: deploymentsWithRuns,
        runGroups: await serializeRunGroups(runGroupsData),
      },
    })
  },
)

/**
 * GET /api/orgs/:org/repos/:repo/env/:branch/stream
 *
 * SSE stream for environment updates (all workspaces).
 */
reposRoute.get(
  "/:org/repos/:repo/env/:branch/stream",
  requireOrgAccess({ orgSource: "param", orgKey: "org" }),
  async (c) => {
    const auth = getAuth(c)
    const repo = c.req.param("repo")
    const branch = c.req.param("branch")
    if (!repo || !branch) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "repo and branch are required" } },
        400,
      )
    }

    // For legacy env routes, branch name is the environment name
    const environmentName = branch

    return streamSSE(c, async (stream) => {
      getSseConnectionsActiveCounter().add(1, { type: "env" })
      let lastPayload = ""
      let inFlight = false
      let pendingUpdate = false

      const sendSnapshot = async (): Promise<void> => {
        // If already fetching, mark that we need another update after
        if (inFlight) {
          pendingUpdate = true
          return
        }
        inFlight = true
        pendingUpdate = false

        try {
          const startTime = performance.now()
          const deployments = await findDeploymentsByEnvironment(auth.orgId, repo, environmentName)
          const runGroupsData = await listRunGroupsForBranch(auth.orgId, repo, branch)

          if (deployments.length === 0) {
            const emptyPayload =
              runGroupsData.length === 0
                ? JSON.stringify({ data: null })
                : JSON.stringify({
                    data: {
                      org: c.req.param("org"),
                      repo,
                      branch,
                      headSha: runGroupsData[0]?.headSha ?? "",
                      workspaces: [],
                      runGroups: await serializeRunGroups(runGroupsData),
                    },
                  })
            if (emptyPayload !== lastPayload) {
              lastPayload = emptyPayload
              await stream.writeSSE({ event: "update", data: emptyPayload })
            }
            return
          }

          const deploymentsWithRuns = await Promise.all(
            deployments.map(async (deployment) => {
              const runs = await listRunsForPreview(deployment.id)
              const latestApply = await findLatestSuccessfulRun(deployment.id, "apply")
              const outputAudience = outputAudienceForAuth(auth)
              const outputs = selectEnvironmentOutputs(latestApply?.outputs, outputAudience, {})
              const connectionReadiness = await getConnectionReadinessForDeployment(deployment)

              // Include resource spans for running deployments
              const isRunning =
                deployment.status === "planning" ||
                deployment.status === "applying" ||
                deployment.status === "destroying"
              const runningRun = isRunning ? runs.find((r) => r.status === "running") : null
              const resourceSpans = runningRun
                ? (await getSpansForRun(runningRun.id)).map(serializeResourceSpan)
                : undefined

              return {
                preview: serializePreview(deployment, connectionReadiness),
                runs: runs.map((run) => serializeRun(run, outputAudience, {})),
                outputs,
                ...(resourceSpans ? { resourceSpans } : {}),
              }
            }),
          )

          const queryDuration = performance.now() - startTime
          getSseSnapshotDurationHistogram().record(queryDuration, {
            type: "env",
            workspace_count: String(deploymentsWithRuns.length),
          })

          const first = deployments[0]
          const payload = JSON.stringify({
            data: {
              org: c.req.param("org"),
              repo,
              branch,
              headSha: first.headSha,
              workspaces: deploymentsWithRuns,
              runGroups: await serializeRunGroups(runGroupsData),
            },
          })

          if (payload !== lastPayload) {
            lastPayload = payload
            getSsePayloadBytesHistogram().record(payload.length, { type: "env" })
            getSseMessagesSentCounter().add(1, { type: "snapshot" })
            await stream.writeSSE({ event: "update", data: payload })
          } else {
            getSseMessagesDedupedCounter().add(1, { type: "env" })
          }
        } finally {
          inFlight = false
          // If updates came in while we were fetching, fetch again
          if (pendingUpdate) {
            await sendSnapshot()
          }
        }
      }

      // Send initial snapshot
      await sendSnapshot()

      // Track deployment IDs for this env to filter events
      let deploymentIds = new Set<string>()
      const updateDeploymentIds = async (): Promise<void> => {
        const deployments = await findDeploymentsByEnvironment(auth.orgId, repo, environmentName)
        deploymentIds = new Set(deployments.map((d) => d.id))
      }
      await updateDeploymentIds()

      // Listen for deployment updates matching this environment
      const handleDeploymentUpdate = (event: DeploymentUpdateEvent): void => {
        if (
          event.orgId === auth.orgId &&
          event.repo === repo &&
          event.environmentName === environmentName
        ) {
          updateDeploymentIds()
            .then(() => sendSnapshot())
            .catch((err) => console.error(`[sse:env] error in handleDeploymentUpdate:`, err))
        }
      }

      // Listen for run updates for any deployment in this env
      const handleRunUpdate = (event: RunUpdateEvent): void => {
        if (deploymentIds.has(event.deploymentId)) {
          sendSnapshot().catch((err) => console.error(`[sse:env] error in handleRunUpdate:`, err))
        }
      }

      const handleJobUpdate = (event: JobUpdateEvent): void => {
        if (deploymentIds.has(event.deploymentId)) {
          sendSnapshot().catch((err) => console.error(`[sse:env] error in handleJobUpdate:`, err))
        }
      }

      events.onDeploymentUpdate(handleDeploymentUpdate)
      events.onRunUpdate(handleRunUpdate)
      events.onJobUpdate(handleJobUpdate)

      // Heartbeat to keep connection alive
      const heartbeat = setInterval(() => {
        stream
          .writeSSE({ event: "heartbeat", data: JSON.stringify({ ts: Date.now() }) })
          .catch(() => {
            /* connection likely closed */
          })
      }, 30_000)

      // Block the callback so Hono doesn't call stream.close() in its
      // finally block.  Resolves only when the client disconnects.
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          getSseConnectionsActiveCounter().add(-1, { type: "env" })
          clearInterval(heartbeat)
          events.offDeploymentUpdate(handleDeploymentUpdate)
          events.offRunUpdate(handleRunUpdate)
          events.offJobUpdate(handleJobUpdate)
          resolve()
        })
      })
    })
  },
)

// ---------------------------------------------------------------------------
// Unified Environment Route (replaces both PR and branch routes)
// ---------------------------------------------------------------------------

interface EnvironmentSnapshotData {
  org: string
  repo: string
  environmentKind: "named" | "transient"
  environmentName: string
  ref: string
  headSha: string
  prNumber: number | null
  authorGithubId: number | null
  authorLogin: string | null
  environmentPolicy?: SerializedEnvironmentPolicy | null
  environmentLifecycle?: SerializedEnvironmentLifecycle | null
  workspaces: Array<WorkspaceWithRunsForResponse>
  runGroups: SerializedRunGroup[]
}

type SerializedEnvironmentPolicy = {
  minimumPrincipalTier: string
  lifecycleDispatch: string
  allowedDestinationClasses: string[]
}

type SerializedLifecycleEvent = {
  id: string
  eventType: string
  payload: Record<string, unknown>
  createdAt: string
}

type SerializedLifecycleItem = {
  id: string
  runId: string
  workspacePath: string
  key: string
  phase: string
  state: string
  failurePolicy: string
  scopes: string[]
  summary: string | null
  reason: string | null
  metadata: Record<string, unknown>
  destinationUrl: string
  startedAt: string | null
  finishedAt: string | null
  events: SerializedLifecycleEvent[]
}

type SerializedEnvironmentLifecycle = {
  run: {
    id: string
    runGroupId: string | null
    status: string
    executionMode: string
    startedAt: string
    finishedAt: string | null
  }
  items: SerializedLifecycleItem[]
}

type WorkspaceWithRunsForResponse = {
  preview: SerializedPreview
  runs: SerializedRun[]
  outputs: unknown
  resourceSpans?: SerializedResourceSpan[]
}

async function buildEnvironmentSnapshotData(params: {
  orgId: string
  orgSlug: string
  repo: string
  environmentName: string
  headSha?: string
  detailLevel?: "full" | "dag"
  includeResourceSpans?: boolean
  outputAudience?: "viewer" | "automation"
}): Promise<EnvironmentSnapshotData | null> {
  const repoRecord = await findRepoByName(params.orgId, params.repo)
  const canonicalRepoNamespace = repoRecord?.fullName
    ? canonicalRepoNamespaceFromRepoFullName(repoRecord.fullName)
    : null
  const environmentPolicy = repoRecord?.fullName
    ? await findEnvironmentPolicy({
        orgId: params.orgId,
        repoFullName: repoRecord.fullName,
        environmentName: params.environmentName,
      })
    : undefined
  const lifecycleState = canonicalRepoNamespace
    ? await getLatestLifecycleStateForRepoEnvironment({
        canonicalRepoNamespace,
        environmentName: params.environmentName,
      })
    : undefined
  const lifecycleEvents = lifecycleState
    ? await listLifecycleEventsForItems(lifecycleState.items.map((item) => item.id))
    : []
  const environmentLifecycle = lifecycleState
    ? serializeEnvironmentLifecycle(lifecycleState.run, lifecycleState.items, lifecycleEvents)
    : null
  const [allDeployments, allRunGroups] = await Promise.all([
    findDeploymentsByEnvironment(params.orgId, params.repo, params.environmentName),
    listRunGroupsForEnvironment(params.orgId, params.repo, params.environmentName),
  ])

  const deployments = filterDeploymentsByHeadSha(allDeployments, params.headSha)
  const runGroupsData = filterRunGroupsByHeadSha(allRunGroups, params.headSha)
  const runGroupsById = new Map(allRunGroups.map((runGroup) => [runGroup.id, runGroup]))
  const serializedRunGroups = await serializeRunGroupsWithLifecycle(runGroupsData)

  if (deployments.length === 0) {
    if (runGroupsData.length === 0) {
      return null
    }

    const latestRunGroup = runGroupsData[0]
    return {
      org: params.orgSlug,
      repo: params.repo,
      environmentKind: latestRunGroup.environmentKind,
      environmentName: params.environmentName,
      ref: latestRunGroup.ref,
      headSha: latestRunGroup.headSha,
      prNumber: latestRunGroup.prNumber,
      authorGithubId: null,
      authorLogin: null,
      environmentPolicy: environmentPolicy ? serializeEnvironmentPolicy(environmentPolicy) : null,
      environmentLifecycle,
      workspaces: [],
      runGroups: serializedRunGroups,
    }
  }

  const deploymentIds = deployments.map((deployment) => deployment.id)
  const defaultReadiness = {
    status: "not_required" as const,
    missingProviders: [],
    conflictProviders: [],
    matchedConnections: [],
  }

  if (params.detailLevel === "dag") {
    const readinessEntries = await Promise.all(
      deployments.map(
        async (deployment) =>
          [deployment.id, await getConnectionReadinessForDeployment(deployment)] as const,
      ),
    )
    const readinessByDeployment = new Map(readinessEntries)

    const workspaces = deployments.map((deployment) => ({
      preview: serializePreview(
        deployment,
        readinessByDeployment.get(deployment.id) ?? defaultReadiness,
      ),
      runs: [],
      outputs: null,
    }))

    const first = deployments[0]
    return {
      org: params.orgSlug,
      repo: params.repo,
      environmentKind: first.environmentKind,
      environmentName: first.environmentName,
      ref: first.ref,
      headSha: first.headSha,
      prNumber: first.prNumber,
      authorGithubId: first.authorGithubId,
      authorLogin: first.authorLogin,
      environmentPolicy: environmentPolicy ? serializeEnvironmentPolicy(environmentPolicy) : null,
      environmentLifecycle,
      workspaces,
      runGroups: serializedRunGroups,
    }
  }

  const visibleRunGroupIds = [...new Set(runGroupsData.map((runGroup) => runGroup.id))]
  const deploymentRunGroupIds = [
    ...new Set(
      deployments
        .map((deployment) => deployment.runGroupId)
        .filter((runGroupId): runGroupId is string => typeof runGroupId === "string"),
    ),
  ]

  const [
    runsByDeployment,
    latestApplyByDeployment,
    orgConnections,
    metadataByRunGroupWorkspaceKey,
  ] = await Promise.all([
    visibleRunGroupIds.length > 0
      ? listRunsForDeployments(deploymentIds, { runGroupIds: visibleRunGroupIds })
      : listRunsForDeployments(deploymentIds),
    findLatestSuccessfulRunsForDeployments(deploymentIds, "apply"),
    listConnectionsForOrg(params.orgId),
    findRunGroupWorkspaceMetadataForRunGroups(deploymentRunGroupIds),
  ])

  const readinessEntries = await Promise.all(
    deployments.map(async (deployment) => {
      const readiness = await getConnectionReadinessForDeploymentWithDeps(deployment, {
        getProvidersForDeployment: (currentDeployment) =>
          getRequiredProvidersForDeployment(currentDeployment, {
            metadata: currentDeployment.runGroupId
              ? (metadataByRunGroupWorkspaceKey.get(
                  `${currentDeployment.runGroupId}:${currentDeployment.workspacePath}`,
                ) ?? null)
              : null,
          }),
        getProviderRequirementsForDeployment: (currentDeployment) =>
          getRequiredProviderRequirementsForDeployment(currentDeployment, {
            metadata: currentDeployment.runGroupId
              ? (metadataByRunGroupWorkspaceKey.get(
                  `${currentDeployment.runGroupId}:${currentDeployment.workspacePath}`,
                ) ?? null)
              : null,
          }),
        listConnectionsForOrg: async () => orgConnections,
        resolveConnectionEnv: async () => ({}),
      })

      return [deployment.id, readiness] as const
    }),
  )
  const readinessByDeployment = new Map(readinessEntries)

  const resourceSpansByRunId = new Map<string, SerializedResourceSpan[]>()
  if (params.includeResourceSpans) {
    const runningRuns = deployments
      .map((deployment) => {
        const isRunning =
          deployment.status === "planning" ||
          deployment.status === "applying" ||
          deployment.status === "destroying"
        if (!isRunning) {
          return null
        }

        const runs = runsByDeployment.get(deployment.id) ?? []
        return runs.find((run) => run.status === "running") ?? null
      })
      .filter((run): run is TfRunListItem => run !== null)

    const spanEntries = await Promise.all(
      runningRuns.map(async (run) => {
        const spans = (await getSpansForRun(run.id)).map(serializeResourceSpan)
        return [run.id, spans] as const
      }),
    )

    for (const [runId, spans] of spanEntries) {
      resourceSpansByRunId.set(runId, spans)
    }
  }

  const workspaces = deployments.map((deployment) => {
    const runs = runsByDeployment.get(deployment.id) ?? []
    const latestApply = latestApplyByDeployment.get(deployment.id)
    const outputPoliciesForRunGroup = (
      runGroupId: string | null | undefined,
    ): Record<string, WorkspaceOutputPolicy> => {
      const runGroup = runGroupId ? runGroupsById.get(runGroupId) : undefined
      return (
        findExecutionSnapshotWorkspace(
          runGroup?.executionSnapshot ?? null,
          deployment.workspacePath,
        )?.outputs ?? {}
      )
    }
    const outputAudience = params.outputAudience ?? "viewer"
    const connectionReadiness = readinessByDeployment.get(deployment.id) ?? defaultReadiness
    const runningRun = params.includeResourceSpans
      ? runs.find((run) => run.status === "running")
      : undefined
    const resourceSpans = runningRun ? resourceSpansByRunId.get(runningRun.id) : undefined

    return {
      preview: serializePreview(deployment, connectionReadiness),
      runs: runs.map((run) =>
        serializeRun(run, outputAudience, outputPoliciesForRunGroup(run.runGroupId)),
      ),
      outputs: selectEnvironmentOutputs(
        latestApply?.outputs,
        outputAudience,
        outputPoliciesForRunGroup(latestApply?.runGroupId),
      ),
      ...(resourceSpans && resourceSpans.length > 0 ? { resourceSpans } : {}),
    }
  })

  const first = deployments[0]
  return {
    org: params.orgSlug,
    repo: params.repo,
    environmentKind: first.environmentKind,
    environmentName: first.environmentName,
    ref: first.ref,
    headSha: first.headSha,
    prNumber: first.prNumber,
    authorGithubId: first.authorGithubId,
    authorLogin: first.authorLogin,
    environmentPolicy: environmentPolicy ? serializeEnvironmentPolicy(environmentPolicy) : null,
    environmentLifecycle,
    workspaces,
    runGroups: serializedRunGroups,
  }
}

function serializeEnvironmentPolicy(
  policy: Awaited<ReturnType<typeof findEnvironmentPolicy>> extends infer T
    ? Exclude<T, undefined>
    : never,
): SerializedEnvironmentPolicy {
  return {
    minimumPrincipalTier: policy.minimumPrincipalTier,
    lifecycleDispatch: policy.lifecycleDispatch,
    allowedDestinationClasses: policy.allowedDestinationClasses,
  }
}

function serializeEnvironmentLifecycle(
  run: LifecycleRun,
  items: LifecycleItem[],
  events: LifecycleEvent[],
): SerializedEnvironmentLifecycle {
  return {
    run: {
      id: run.id,
      runGroupId: run.runGroupId,
      status: run.status,
      executionMode: run.executionMode,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
    },
    items: items.map((item) =>
      serializeLifecycleItem(
        item,
        events.filter((event) => event.itemId === item.id),
      ),
    ),
  }
}

function serializeLifecycleItem(
  item: LifecycleItem,
  events: LifecycleEvent[],
): SerializedLifecycleItem {
  return {
    id: item.id,
    runId: item.runId,
    workspacePath: item.workspacePath,
    key: item.key,
    phase: item.phase,
    state: item.state,
    failurePolicy: item.failurePolicy,
    scopes: item.scopes,
    summary: item.summary ?? null,
    reason: item.reason ?? null,
    metadata: item.metadata as Record<string, unknown>,
    destinationUrl: item.destinationUrl,
    startedAt: item.startedAt?.toISOString() ?? null,
    finishedAt: item.finishedAt?.toISOString() ?? null,
    events: events.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      payload: event.payload as Record<string, unknown>,
      createdAt: event.createdAt.toISOString(),
    })),
  }
}

function canonicalRepoNamespaceFromRepoFullName(repoFullName: string): string {
  return repoFullName.replace("/", "--")
}

/**
 * GET /api/orgs/:org/repos/:repo/environment/:name
 *
 * Unified endpoint for all deployments in an environment.
 * Works for both PR environments (e.g., "pr-123") and named environments (e.g., "main").
 */
reposRoute.get(
  "/:org/repos/:repo/environment/:name",
  requireOrgAccess({ orgSource: "param", orgKey: "org" }),
  async (c) => {
    const auth = getAuth(c)
    const org = c.req.param("org")
    const repo = c.req.param("repo")
    const environmentName = c.req.param("name")
    if (!org || !repo || !environmentName) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "org, repo, and environment name are required",
          },
        },
        400,
      )
    }

    const parsedQuery = environmentQuerySchema.safeParse(c.req.query())
    if (!parsedQuery.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: parsedQuery.error.issues[0]?.message ?? "invalid query",
          },
        },
        400,
      )
    }

    const headSha = parsedQuery.data.head_sha
    const detailLevel = parsedQuery.data.view ?? "full"
    const outputAudience = outputAudienceForAuth(auth, parsedQuery.data.output_audience)
    if (!apiKeyCanAccessOutputRepo(auth, repo)) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "API key is not scoped to this output repository",
          },
        },
        403,
      )
    }

    const snapshot = await buildEnvironmentSnapshotData({
      orgId: auth.orgId,
      orgSlug: org,
      repo,
      environmentName,
      headSha,
      detailLevel,
      outputAudience,
    })

    if (!snapshot) {
      return c.json(
        {
          error: {
            code: "NOT_FOUND",
            message: `no deployments found for environment ${environmentName}`,
          },
        },
        404,
      )
    }

    return c.json({
      data: snapshot,
    })
  },
)

reposRoute.post(
  "/:org/repos/:repo/environment/:name/telemetry",
  requireOrgAccess({ orgSource: "param", orgKey: "org" }),
  async (c) => {
    const auth = getAuth(c)
    const org = c.req.param("org")
    const repo = c.req.param("repo")
    const environmentName = c.req.param("name")
    if (!org || !repo || !environmentName) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "org, repo, and environment name are required",
          },
        },
        400,
      )
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "body must be valid JSON" } },
        400,
      )
    }

    const parsed = runViewTelemetryBatchSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: parsed.error.issues[0]?.message ?? "invalid telemetry payload",
          },
        },
        400,
      )
    }

    for (const event of parsed.data.events) {
      logger.info("run_view.client_event", {
        orgId: auth.orgId,
        orgSlug: org,
        repo,
        environmentName,
        eventName: event.name,
        occurredAt: event.occurredAt,
        runViewSessionId: event.runViewSessionId ?? undefined,
        pageViewId: event.pageViewId ?? undefined,
        runGroupId: event.runGroupId ?? undefined,
        runId: event.runId ?? undefined,
        workspacePath: event.workspacePath ?? undefined,
        runType: event.runType ?? undefined,
        durationMs: event.durationMs,
        workspaceCount: event.workspaceCount,
        affectedWorkspaceCount: event.affectedWorkspaceCount,
        usedPlaceholderDag: event.usedPlaceholderDag,
        selectionSource: event.selectionSource,
        surface: event.surface,
        streamType: event.streamType ?? undefined,
        sourceEventType: event.sourceEventType ?? undefined,
        sourceEventAt: event.sourceEventAt ?? undefined,
        sentAt: event.sentAt ?? undefined,
        freshnessMs: event.freshnessMs,
        transportMs: event.transportMs,
        clientApplyMs: event.clientApplyMs,
        reconnectCount: event.reconnectCount,
        stallThresholdMs: event.stallThresholdMs,
        connectionState: event.connectionState ?? undefined,
        isVisible: event.isVisible,
        telemetrySource: "browser",
      })
    }

    return c.json({ data: { accepted: parsed.data.events.length } }, 202)
  },
)

/**
 * GET /api/orgs/:org/repos/:repo/environment/:name/stream
 *
 * Unified SSE stream for environment updates (all workspaces).
 */
reposRoute.get(
  "/:org/repos/:repo/environment/:name/stream",
  requireOrgAccess({ orgSource: "param", orgKey: "org" }),
  async (c) => {
    const auth = getAuth(c)
    const org = c.req.param("org")
    const repo = c.req.param("repo")
    const environmentName = c.req.param("name")
    if (!org || !repo || !environmentName) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "org, repo, and environment name are required",
          },
        },
        400,
      )
    }

    const parsedQuery = environmentQuerySchema.safeParse(c.req.query())
    if (!parsedQuery.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: parsedQuery.error.issues[0]?.message ?? "invalid query",
          },
        },
        400,
      )
    }

    const headSha = parsedQuery.data.head_sha
    const outputAudience = outputAudienceForAuth(auth, parsedQuery.data.output_audience)
    if (!apiKeyCanAccessOutputRepo(auth, repo)) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "API key is not scoped to this output repository",
          },
        },
        403,
      )
    }
    const correlation = parseRunViewCorrelation(parsedQuery.data)

    return streamSSE(c, async (stream) => {
      const streamContext = createStreamContext("environment", correlation)
      let latestTrigger = {
        sourceEventType: "initial",
        sourceEventAt: new Date().toISOString(),
      }

      getSseConnectionsActiveCounter().add(1, { type: "environment" })
      logger.debug("Environment stream opened", {
        orgId: auth.orgId,
        repo,
        environmentName,
        streamId: streamContext.streamId,
        runViewSessionId: streamContext.runViewSessionId ?? undefined,
        pageViewId: streamContext.pageViewId ?? undefined,
      })

      let lastPayload = ""
      let inFlight = false
      let pendingUpdate = false
      let deploymentIds = new Set<string>()

      const requestSnapshot = async (trigger: {
        sourceEventType: string
        sourceEventAt: string
      }): Promise<void> => {
        latestTrigger = trigger
        await sendSnapshot()
      }

      const sendSnapshot = async (): Promise<void> => {
        if (inFlight) {
          pendingUpdate = true
          return
        }
        inFlight = true

        try {
          const trigger = latestTrigger
          const start = Date.now()
          const snapshot = await buildEnvironmentSnapshotData({
            orgId: auth.orgId,
            orgSlug: org,
            repo,
            environmentName,
            headSha,
            includeResourceSpans: true,
            outputAudience,
          })
          deploymentIds = new Set(
            snapshot?.workspaces.map((workspace) => workspace.preview.id) ?? [],
          )

          const elapsed = Date.now() - start
          getSseSnapshotDurationHistogram().record(elapsed, { type: "environment" })

          const sentAt = new Date().toISOString()
          const payload = JSON.stringify({
            data: snapshot,
            meta: buildStreamPayloadMeta({
              context: streamContext,
              sourceEventType: trigger.sourceEventType,
              sourceEventAt: trigger.sourceEventAt,
              sentAt,
            }),
          })

          if (payload !== lastPayload) {
            lastPayload = payload
            getSsePayloadBytesHistogram().record(payload.length, { type: "environment" })
            getSseMessagesSentCounter().add(1, { type: "snapshot" })

            const sourceEventMs = Date.parse(trigger.sourceEventAt)
            if (Number.isFinite(sourceEventMs)) {
              getSseEventToSendLatencyHistogram().record(Date.now() - sourceEventMs, {
                type: "environment",
                sourceEventType: trigger.sourceEventType,
              })
            }

            await stream.writeSSE({ event: "update", data: payload })
          } else {
            getSseMessagesDedupedCounter().add(1, { type: "environment" })
          }
        } finally {
          inFlight = false
          if (pendingUpdate) {
            pendingUpdate = false
            await sendSnapshot()
          }
        }
      }

      // Send initial snapshot
      await requestSnapshot({
        sourceEventType: "initial",
        sourceEventAt: new Date().toISOString(),
      })

      // Listen for deployment updates matching this environment
      const handleDeploymentUpdate = (event: DeploymentUpdateEvent): void => {
        if (
          event.orgId === auth.orgId &&
          event.repo === repo &&
          event.environmentName === environmentName
        ) {
          requestSnapshot({
            sourceEventType: "deployment_update",
            sourceEventAt: event.emittedAt,
          }).catch((err) =>
            console.error(`[sse:environment] error in handleDeploymentUpdate:`, err),
          )
        }
      }

      // Listen for run updates for any deployment in this environment
      const handleRunUpdate = (event: RunUpdateEvent): void => {
        if (deploymentIds.has(event.deploymentId)) {
          requestSnapshot({
            sourceEventType: "run_update",
            sourceEventAt: event.emittedAt,
          }).catch((err) => console.error(`[sse:environment] error in handleRunUpdate:`, err))
        }
      }

      const handleJobUpdate = (event: JobUpdateEvent): void => {
        if (deploymentIds.has(event.deploymentId)) {
          requestSnapshot({
            sourceEventType: "job_update",
            sourceEventAt: event.emittedAt,
          }).catch((err) => console.error(`[sse:environment] error in handleJobUpdate:`, err))
        }
      }

      events.onDeploymentUpdate(handleDeploymentUpdate)
      events.onRunUpdate(handleRunUpdate)
      events.onJobUpdate(handleJobUpdate)

      // Heartbeat to keep connection alive
      const heartbeat = setInterval(() => {
        stream
          .writeSSE({
            event: "heartbeat",
            data: JSON.stringify({
              ts: Date.now(),
              meta: buildStreamPayloadMeta({
                context: streamContext,
                sourceEventType: "heartbeat",
                sourceEventAt: new Date().toISOString(),
              }),
            }),
          })
          .catch(() => {
            /* connection likely closed */
          })
      }, 30_000)

      // Block until client disconnects
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          getSseConnectionsActiveCounter().add(-1, { type: "environment" })
          clearInterval(heartbeat)
          events.offDeploymentUpdate(handleDeploymentUpdate)
          events.offRunUpdate(handleRunUpdate)
          events.offJobUpdate(handleJobUpdate)
          logger.debug("Environment stream closed", {
            orgId: auth.orgId,
            repo,
            environmentName,
            streamId: streamContext.streamId,
            runViewSessionId: streamContext.runViewSessionId ?? undefined,
            pageViewId: streamContext.pageViewId ?? undefined,
          })
          resolve()
        })
      })
    })
  },
)

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function filterDeploymentsByHeadSha<T extends { headSha: string }>(
  deployments: T[],
  headSha?: string,
): T[] {
  if (!headSha) {
    return deployments
  }
  return deployments.filter((deployment) => deployment.headSha === headSha)
}

function filterRunGroupsByHeadSha(runGroups: RunGroup[], headSha?: string): RunGroup[] {
  if (!headSha) {
    return runGroups
  }
  return runGroups.filter((runGroup) => runGroup.headSha === headSha)
}

interface SerializedPreview {
  id: string
  workspacePath: string
  status: string
  connectionStatus: "ready" | "missing" | "conflict" | "not_required"
  missingProviders: string[]
  conflictProviders: string[]
  matchedConnections: Array<{ id: string; name: string; provider: string }>
  blockedReason: string | null
  degradation: WorkspaceDegradation | null
  stateKey: string
  mode: string
  requireApproval: boolean
  createdAt: string
}

function serializePreview(
  p: {
    id: string
    workspacePath: string
    status: string
    stateKey: string
    mode: string
    requireApproval: boolean
    createdAt: Date
    blockedReason?: string | null
  },
  readiness: {
    status: "ready" | "missing" | "conflict" | "not_required"
    missingProviders: string[]
    conflictProviders: string[]
    matchedConnections: Array<{ id: string; name: string; provider: string }>
    degradation?: WorkspaceDegradation | null
  },
): SerializedPreview {
  return {
    id: p.id,
    workspacePath: p.workspacePath,
    status: p.status,
    connectionStatus: readiness.status,
    missingProviders: readiness.missingProviders,
    conflictProviders: readiness.conflictProviders,
    matchedConnections: readiness.matchedConnections,
    blockedReason: formatConnectionBlockedReason(readiness),
    degradation: readiness.degradation ?? null,
    stateKey: p.stateKey,
    mode: p.mode,
    requireApproval: p.requireApproval,
    createdAt: p.createdAt.toISOString(),
  }
}

interface SerializedRun {
  id: string
  deploymentId: string
  runGroupId: string | null
  runType: string
  status: string
  checkRunId: number | null
  planSummary: string | null
  outputs: unknown
  errorMessage: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
}

function serializeRun(
  r: {
    id: string
    deploymentId: string
    runGroupId: string | null
    runType: string
    status: string
    checkRunId: number | null
    planSummary: string | null
    outputs: unknown
    errorMessage: string | null
    startedAt: Date | null
    completedAt: Date | null
    createdAt: Date
  },
  outputAudience: "viewer" | "automation",
  outputPolicies: Record<string, WorkspaceOutputPolicy>,
): SerializedRun {
  return {
    id: r.id,
    deploymentId: r.deploymentId,
    runGroupId: r.runGroupId,
    runType: r.runType,
    status: r.status,
    checkRunId: r.checkRunId,
    planSummary: r.planSummary,
    outputs: selectEnvironmentOutputs(r.outputs, outputAudience, outputPolicies),
    errorMessage: r.errorMessage,
    startedAt: r.startedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }
}

function selectEnvironmentOutputs(
  outputs: unknown,
  audience: "viewer" | "automation",
  policies: Record<string, WorkspaceOutputPolicy>,
): ReturnType<typeof selectTerraformOutputs> {
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) {
    return null
  }

  return selectTerraformOutputs({
    outputs: outputs as Record<string, unknown>,
    selection: audience === "viewer" ? { kind: "all" } : { kind: "policy", policies },
    sensitive: "redact",
  })
}

function outputAudienceForAuth(
  auth: OrgAuthContext,
  requested: "viewer" | "automation" = "viewer",
): "viewer" | "automation" {
  return auth.apiKeyId ? "automation" : requested
}

function apiKeyCanAccessOutputRepo(auth: OrgAuthContext, repo: string): boolean {
  return !auth.apiKeyId || auth.apiKeyMetadata?.repo === repo
}

interface SerializedResourceSpan {
  id: string
  resourceAddress: string
  resourceType: string | null
  action: string
  status: string
  startedAt: string
  completedAt: string | null
  durationMs: number | null
}

function serializeResourceSpan(s: {
  id: string
  resourceAddress: string
  resourceType: string | null
  action: string
  status: string
  startedAt: Date
  completedAt: Date | null
  durationMs: number | null
}): SerializedResourceSpan {
  return {
    id: s.id,
    resourceAddress: s.resourceAddress,
    resourceType: s.resourceType,
    action: s.action,
    status: s.status,
    startedAt: s.startedAt.toISOString(),
    completedAt: s.completedAt?.toISOString() ?? null,
    durationMs: s.durationMs,
  }
}

interface SerializedDependencyGraph {
  workspaces: string[]
  edges: [string, string][]
}

interface SerializedSystemErrorLine {
  lineNumber: number
  text: string
  highlight: boolean
}

interface SerializedSystemError {
  kind: "config"
  title: string
  summary: string
  filePath: string
  line: number | null
  column: number | null
  excerpt: SerializedSystemErrorLine[]
}

interface SerializedRunGroup {
  id: string
  repo: string
  prNumber: number | null
  ref: string
  headSha: string
  selectedWorkspacePaths: string[]
  executionContext: {
    version: 1
    commitSha: string
    configurationRevision: string
    configurationDigest: string
  } | null
  trigger: string
  triggeredByLogin: string | null
  status: string
  dependencyGraph: SerializedDependencyGraph | null
  systemError: SerializedSystemError | null
  environmentLifecycle?: SerializedEnvironmentLifecycle | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

async function serializeRunGroups(runGroups: RunGroup[]): Promise<SerializedRunGroup[]> {
  return Promise.all(
    runGroups.map(async (runGroup) => {
      const repoBinding = runGroup.repoBindingId
        ? await findPrincipalRepoBindingById(runGroup.repoBindingId)
        : undefined
      return serializeRunGroup(runGroup, null, repoBinding?.canonicalRepoNamespace)
    }),
  )
}

async function serializeRunGroupsWithLifecycle(
  runGroups: RunGroup[],
): Promise<SerializedRunGroup[]> {
  return Promise.all(
    runGroups.map(async (runGroup) => {
      const [lifecycleState, repoBinding] = await Promise.all([
        getLifecycleStateForRunGroup(runGroup.id),
        runGroup.repoBindingId
          ? findPrincipalRepoBindingById(runGroup.repoBindingId)
          : Promise.resolve(undefined),
      ])
      const lifecycleEvents = lifecycleState
        ? await listLifecycleEventsForItems(lifecycleState.items.map((item) => item.id))
        : []
      return serializeRunGroup(
        runGroup,
        lifecycleState
          ? serializeEnvironmentLifecycle(lifecycleState.run, lifecycleState.items, lifecycleEvents)
          : null,
        repoBinding?.canonicalRepoNamespace,
      )
    }),
  )
}

function serializeRunGroup(
  rg: RunGroup,
  environmentLifecycle?: SerializedEnvironmentLifecycle | null,
  canonicalRepoNamespace?: string,
): SerializedRunGroup {
  const rawGraph = rg.dependencyGraph as
    | (SerializedDependencyGraph & { systemError?: SerializedSystemError })
    | null
  const resource = {
    orgId: rg.orgId,
    repo: rg.repo,
    environmentKind: rg.environmentKind,
    environmentName: rg.environmentName,
  }
  const executionContextValid =
    rg.environmentKind !== "transient" ||
    isExecutionContextAssociationValid({
      snapshot: rg.executionSnapshot,
      runGroup: rg,
      resource,
      canonicalRepoNamespace,
      requireRepoBinding: true,
    })

  return {
    id: rg.id,
    repo: rg.repo,
    prNumber: rg.prNumber,
    ref: rg.ref,
    headSha: rg.headSha,
    selectedWorkspacePaths: Array.isArray(rg.selectedWorkspacePaths)
      ? rg.selectedWorkspacePaths.filter((value): value is string => typeof value === "string")
      : [],
    executionContext: executionContextValid
      ? serializeBoundExecutionSnapshotIdentity({
          snapshot: rg.executionSnapshot,
          runGroup: rg,
          resource,
        })
      : null,
    trigger: rg.trigger,
    triggeredByLogin: rg.triggeredByLogin,
    status: rg.status,
    dependencyGraph: rawGraph
      ? {
          workspaces: rawGraph.workspaces,
          edges: rawGraph.edges,
        }
      : null,
    systemError: rawGraph?.systemError ?? null,
    environmentLifecycle,
    createdAt: rg.createdAt.toISOString(),
    startedAt: rg.startedAt?.toISOString() ?? null,
    completedAt: rg.completedAt?.toISOString() ?? null,
  }
}
