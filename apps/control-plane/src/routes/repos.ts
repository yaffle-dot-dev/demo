import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"

import {
  findDeploymentsByEnvironment,
} from "../db/queries/workspace-deployments.ts"
import {
  listRunsForPreview,
  listRunsForDeployments,
  findLatestSuccessfulRun,
  findLatestSuccessfulRunsForDeployments,
  type TfRunListItem,
} from "../db/queries/tf-runs.ts"
import { getSpansForRun } from "../db/queries/resource-spans.ts"
import { findLatestJobForDeployment, findLatestJobsForDeployments } from "../db/queries/iac-jobs.ts"
import { listConnectionsForOrg } from "../db/queries/connections.ts"
import {
  findRunGroupsByIds,
  listRunGroupsForPr,
  listRunGroupsForBranch,
  listRunGroupsForEnvironment,
  type RunGroup,
} from "../db/queries/run-groups.ts"
import { requireOrgAccess, getAuth } from "../middleware/org-auth.ts"
import { events, type DeploymentUpdateEvent, type RunUpdateEvent } from "../lib/events.ts"
import {
  getSseSnapshotDurationHistogram,
  getSsePayloadBytesHistogram,
  getSseMessagesSentCounter,
  getSseMessagesDedupedCounter,
  getSseConnectionsActiveCounter,
} from "../lib/telemetry.ts"
import {
  getConnectionReadinessForDeployment,
  getConnectionReadinessForDeploymentWithDeps,
} from "../lib/execution-credentials.ts"
import {
  getRequiredProvidersForDeployments,
} from "../lib/provider-requirements.ts"

const prNumberParam = z.coerce.number().int().positive()
const environmentQuerySchema = z.object({
  head_sha: z.string().min(7).max(64).optional(),
  token: z.string().optional(),
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

    const environmentName = `pr-${prNumber}`
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
          runGroups: runGroupsData.map(serializeRunGroup),
        },
      })
    }

    // Fetch runs for each deployment
    const deploymentsWithRuns = await Promise.all(
      deployments.map(async (deployment) => {
        const runs = await listRunsForPreview(deployment.id)
        const latestApply = await findLatestSuccessfulRun(deployment.id, "apply")
        const latestJob = await findLatestJobForDeployment(deployment.id)
        const outputs = latestApply?.outputs ?? null
        const connectionReadiness = await getConnectionReadinessForDeployment(deployment)
        return {
          preview: serializePreview({ ...deployment, blockedReason: latestJob?.blockedReason ?? null }, connectionReadiness),
          runs: runs.map(serializeRun),
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
        runGroups: runGroupsData.map(serializeRunGroup),
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
  requireOrgAccess({ orgSource: "param", orgKey: "org", allowQueryToken: true }),
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

    const environmentName = `pr-${prNumber}`

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
            const emptyPayload = runGroupsData.length === 0
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
                    runGroups: runGroupsData.map(serializeRunGroup),
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
              const latestJob = await findLatestJobForDeployment(deployment.id)
              const outputs = latestApply?.outputs ?? null
              const connectionReadiness = await getConnectionReadinessForDeployment(deployment)

              // Include resource spans for running deployments
              const isRunning = deployment.status === "planning" || deployment.status === "applying" || deployment.status === "destroying"
              const runningRun = isRunning ? runs.find((r) => r.status === "running") : null
              const resourceSpans = runningRun
                ? (await getSpansForRun(runningRun.id)).map(serializeResourceSpan)
                : undefined

              return {
                preview: serializePreview({ ...deployment, blockedReason: latestJob?.blockedReason ?? null }, connectionReadiness),
                runs: runs.map(serializeRun),
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
              runGroups: runGroupsData.map(serializeRunGroup),
            },
          })

          if (payload !== lastPayload) {
            lastPayload = payload
            getSsePayloadBytesHistogram().record(payload.length, { type: "pr" })
            getSseMessagesSentCounter().add(1, { type: "snapshot" })
            console.log(`[sse:pr] sending update: workspaces=${deploymentsWithRuns.length} payloadLen=${payload.length}`)
            await stream.writeSSE({ event: "update", data: payload })
          } else {
            getSseMessagesDedupedCounter().add(1, { type: "pr" })
            console.log(`[sse:pr] skipping update: payload unchanged`)
          }
        } finally {
          inFlight = false
          // If updates came in while we were fetching, fetch again
          if (pendingUpdate) {
            console.log(`[sse:pr] processing pending update`)
            await sendSnapshot()
          }
        }
      }

      // Send initial snapshot
      console.log(`[sse:pr] sending initial snapshot for PR #${prNumber}`)
      await sendSnapshot()

      // Track deployment IDs for this PR to filter events
      let deploymentIds = new Set<string>()
      const updateDeploymentIds = async (): Promise<void> => {
        const deployments = await findDeploymentsByEnvironment(auth.orgId, repo, environmentName)
        deploymentIds = new Set(deployments.map((d) => d.id))
        console.log(`[sse:pr] updateDeploymentIds: found ${deploymentIds.size} deployments`)
      }
      await updateDeploymentIds()

      // Listen for deployment updates matching this environment
      const handleDeploymentUpdate = (event: DeploymentUpdateEvent): void => {
        console.log(`[sse:pr] handleDeploymentUpdate: deploymentId=${event.deploymentId} matches=${event.orgId === auth.orgId && event.repo === repo && event.environmentName === environmentName}`)
        if (event.orgId === auth.orgId && event.repo === repo && event.environmentName === environmentName) {
          updateDeploymentIds()
            .then(() => sendSnapshot())
            .catch((err) => console.error(`[sse:pr] error in handleDeploymentUpdate:`, err))
        }
      }

      // Listen for run updates for any deployment in this PR
      const handleRunUpdate = (event: RunUpdateEvent): void => {
        console.log(`[sse:pr] handleRunUpdate: deploymentId=${event.deploymentId} inSet=${deploymentIds.has(event.deploymentId)} setSize=${deploymentIds.size}`)
        if (deploymentIds.has(event.deploymentId)) {
          sendSnapshot().catch((err) => console.error(`[sse:pr] error in handleRunUpdate:`, err))
        }
      }

      events.onDeploymentUpdate(handleDeploymentUpdate)
      events.onRunUpdate(handleRunUpdate)
      console.log(`[sse:pr] connected: PR #${prNumber}`)

      // Heartbeat to keep connection alive
      const heartbeat = setInterval(() => {
        stream.writeSSE({ event: "heartbeat", data: JSON.stringify({ ts: Date.now() }) })
          .catch(() => { /* connection likely closed */ })
      }, 30_000)

      // Block the callback so Hono doesn't call stream.close() in its
      // finally block.  The promise resolves only when the client
      // disconnects and onAbort fires, which lets cleanup run first.
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          console.log(`[sse:pr] onAbort called: PR #${prNumber}`)
          getSseConnectionsActiveCounter().add(-1, { type: "pr" })
          clearInterval(heartbeat)
          events.offDeploymentUpdate(handleDeploymentUpdate)
          events.offRunUpdate(handleRunUpdate)
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
      return c.json({ error: { code: "VALIDATION_ERROR", message: "repo and branch are required" } }, 400)
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
          runGroups: runGroupsData.map(serializeRunGroup),
        },
      })
    }

    // Fetch runs for each deployment
    const deploymentsWithRuns = await Promise.all(
      deployments.map(async (deployment) => {
        const runs = await listRunsForPreview(deployment.id)
        const latestApply = await findLatestSuccessfulRun(deployment.id, "apply")
        const latestJob = await findLatestJobForDeployment(deployment.id)
        const outputs = latestApply?.outputs ?? null
        const connectionReadiness = await getConnectionReadinessForDeployment(deployment)
        return {
          preview: serializePreview({ ...deployment, blockedReason: latestJob?.blockedReason ?? null }, connectionReadiness),
          runs: runs.map(serializeRun),
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
        runGroups: runGroupsData.map(serializeRunGroup),
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
  requireOrgAccess({ orgSource: "param", orgKey: "org", allowQueryToken: true }),
  async (c) => {
    const auth = getAuth(c)
    const repo = c.req.param("repo")
    const branch = c.req.param("branch")
    if (!repo || !branch) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "repo and branch are required" } }, 400)
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
            const emptyPayload = runGroupsData.length === 0
              ? JSON.stringify({ data: null })
              : JSON.stringify({
                  data: {
                    org: c.req.param("org"),
                    repo,
                    branch,
                    headSha: runGroupsData[0]?.headSha ?? "",
                    workspaces: [],
                    runGroups: runGroupsData.map(serializeRunGroup),
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
              const latestJob = await findLatestJobForDeployment(deployment.id)
              const outputs = latestApply?.outputs ?? null
              const connectionReadiness = await getConnectionReadinessForDeployment(deployment)

              // Include resource spans for running deployments
              const isRunning = deployment.status === "planning" || deployment.status === "applying" || deployment.status === "destroying"
              const runningRun = isRunning ? runs.find((r) => r.status === "running") : null
              const resourceSpans = runningRun
                ? (await getSpansForRun(runningRun.id)).map(serializeResourceSpan)
                : undefined

              return {
                preview: serializePreview({ ...deployment, blockedReason: latestJob?.blockedReason ?? null }, connectionReadiness),
                runs: runs.map(serializeRun),
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
              runGroups: runGroupsData.map(serializeRunGroup),
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
        if (event.orgId === auth.orgId && event.repo === repo && event.environmentName === environmentName) {
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

      events.onDeploymentUpdate(handleDeploymentUpdate)
      events.onRunUpdate(handleRunUpdate)
      console.log(`[sse:env] connected: ${branch}`)

      // Heartbeat to keep connection alive
      const heartbeat = setInterval(() => {
        stream.writeSSE({ event: "heartbeat", data: JSON.stringify({ ts: Date.now() }) })
          .catch(() => { /* connection likely closed */ })
      }, 30_000)

      // Block the callback so Hono doesn't call stream.close() in its
      // finally block.  Resolves only when the client disconnects.
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          console.log(`[sse:env] onAbort called: ${branch}`)
          getSseConnectionsActiveCounter().add(-1, { type: "env" })
          clearInterval(heartbeat)
          events.offDeploymentUpdate(handleDeploymentUpdate)
          events.offRunUpdate(handleRunUpdate)
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
  workspaces: Array<WorkspaceWithRunsForResponse>
  runGroups: SerializedRunGroup[]
}

type WorkspaceWithRunsForResponse = {
  preview: SerializedPreview
  runs: SerializedRun[]
  outputs: unknown | null
  resourceSpans?: SerializedResourceSpan[]
}

async function buildEnvironmentSnapshotData(params: {
  orgId: string
  orgSlug: string
  repo: string
  environmentName: string
  headSha?: string
  includeResourceSpans?: boolean
}): Promise<EnvironmentSnapshotData | null> {
  const [allDeployments, allRunGroups] = await Promise.all([
    findDeploymentsByEnvironment(params.orgId, params.repo, params.environmentName),
    listRunGroupsForEnvironment(params.orgId, params.repo, params.environmentName),
  ])

  const deployments = filterDeploymentsByHeadSha(allDeployments, params.headSha)
  const runGroupsData = filterRunGroupsByHeadSha(allRunGroups, params.headSha)
  const serializedRunGroups = runGroupsData.map(serializeRunGroup)

  if (deployments.length === 0) {
    if (runGroupsData.length === 0) {
      return null
    }

    const latestRunGroup = runGroupsData[0]
    return {
      org: params.orgSlug,
      repo: params.repo,
      environmentKind: latestRunGroup.prNumber ? "transient" : "named",
      environmentName: params.environmentName,
      ref: latestRunGroup.ref,
      headSha: latestRunGroup.headSha,
      prNumber: latestRunGroup.prNumber,
      authorGithubId: null,
      authorLogin: null,
      workspaces: [],
      runGroups: serializedRunGroups,
    }
  }

  const deploymentIds = deployments.map((deployment) => deployment.id)
  const visibleRunGroupIds = [...new Set(runGroupsData.map((runGroup) => runGroup.id))]
  const deploymentRunGroupIds = [...new Set(
    deployments
      .map((deployment) => deployment.runGroupId)
      .filter((runGroupId): runGroupId is string => typeof runGroupId === "string"),
  )]

  const [runsByDeployment, latestApplyByDeployment, latestJobsMap, orgConnections, runGroupsById] = await Promise.all([
    visibleRunGroupIds.length > 0
      ? listRunsForDeployments(deploymentIds, { runGroupIds: visibleRunGroupIds })
      : listRunsForDeployments(deploymentIds),
    findLatestSuccessfulRunsForDeployments(deploymentIds, "apply"),
    findLatestJobsForDeployments(deploymentIds),
    listConnectionsForOrg(params.orgId),
    findRunGroupsByIds(deploymentRunGroupIds),
  ])

  const providersByDeployment = await getRequiredProvidersForDeployments(deployments, {
    runGroupsById,
  })

  const readinessEntries = await Promise.all(
    deployments.map(async (deployment) => {
      const readiness = await getConnectionReadinessForDeploymentWithDeps(deployment, {
        getProvidersForDeployment: (currentDeployment) =>
          Promise.resolve(
            providersByDeployment.get(
              `${currentDeployment.runGroupId ?? "no-run-group"}:${currentDeployment.workspacePath}`,
            ) ?? [],
          ),
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
        const isRunning = deployment.status === "planning"
          || deployment.status === "applying"
          || deployment.status === "destroying"
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

  const defaultReadiness = {
    status: "not_required" as const,
    missingProviders: [],
    conflictProviders: [],
    matchedConnections: [],
  }

  const workspaces = deployments.map((deployment) => {
    const runs = runsByDeployment.get(deployment.id) ?? []
    const latestApply = latestApplyByDeployment.get(deployment.id)
    const latestJob = latestJobsMap.get(deployment.id)
    const connectionReadiness = readinessByDeployment.get(deployment.id) ?? defaultReadiness
    const runningRun = params.includeResourceSpans
      ? runs.find((run) => run.status === "running")
      : undefined
    const resourceSpans = runningRun
      ? resourceSpansByRunId.get(runningRun.id)
      : undefined

    return {
      preview: serializePreview(
        { ...deployment, blockedReason: latestJob?.blockedReason ?? null },
        connectionReadiness,
      ),
      runs: runs.map(serializeRun),
      outputs: latestApply?.outputs ?? null,
      ...(resourceSpans && resourceSpans.length > 0 ? { resourceSpans } : {}),
    }
  })

  const first = deployments[0]
  return {
    org: params.orgSlug,
    repo: params.repo,
    environmentKind: first.prNumber ? "transient" : "named",
    environmentName: first.environmentName,
    ref: first.ref,
    headSha: first.headSha,
    prNumber: first.prNumber,
    authorGithubId: first.authorGithubId,
    authorLogin: first.authorLogin,
    workspaces,
    runGroups: serializedRunGroups,
  }
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
      return c.json({ error: { code: "VALIDATION_ERROR", message: "org, repo, and environment name are required" } }, 400)
    }

    const parsedQuery = environmentQuerySchema.safeParse(c.req.query())
    if (!parsedQuery.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: parsedQuery.error.issues[0]?.message ?? "invalid query" } },
        400,
      )
    }

    const headSha = parsedQuery.data.head_sha

    const snapshot = await buildEnvironmentSnapshotData({
      orgId: auth.orgId,
      orgSlug: org,
      repo,
      environmentName,
      headSha,
    })

    if (!snapshot) {
      return c.json(
        { error: { code: "NOT_FOUND", message: `no deployments found for environment ${environmentName}` } },
        404,
      )
    }

    return c.json({
      data: snapshot,
    })
  },
)

/**
 * GET /api/orgs/:org/repos/:repo/environment/:name/stream
 *
 * Unified SSE stream for environment updates (all workspaces).
 */
reposRoute.get(
  "/:org/repos/:repo/environment/:name/stream",
  requireOrgAccess({ orgSource: "param", orgKey: "org", allowQueryToken: true }),
  async (c) => {
    const auth = getAuth(c)
    const org = c.req.param("org")
    const repo = c.req.param("repo")
    const environmentName = c.req.param("name")
    if (!org || !repo || !environmentName) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "org, repo, and environment name are required" } }, 400)
    }

    const parsedQuery = environmentQuerySchema.safeParse(c.req.query())
    if (!parsedQuery.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: parsedQuery.error.issues[0]?.message ?? "invalid query" } },
        400,
      )
    }

    const headSha = parsedQuery.data.head_sha

    return streamSSE(c, async (stream) => {
      getSseConnectionsActiveCounter().add(1, { type: "environment" })
      let lastPayload = ""
      let inFlight = false
      let pendingUpdate = false
      let deploymentIds = new Set<string>()

      const sendSnapshot = async (): Promise<void> => {
        if (inFlight) {
          pendingUpdate = true
          return
        }
        inFlight = true

        try {
          const start = Date.now()
          const snapshot = await buildEnvironmentSnapshotData({
            orgId: auth.orgId,
            orgSlug: org,
            repo,
            environmentName,
            headSha,
            includeResourceSpans: true,
          })
          deploymentIds = new Set(snapshot?.workspaces.map((workspace) => workspace.preview.id) ?? [])

          // Debug logging for UI bug investigation
          const latestRg = snapshot?.runGroups[0]
          console.log(`[sse:environment:debug] latestRunGroup=${latestRg?.id} status=${latestRg?.status}`)
          for (const dwr of snapshot?.workspaces ?? []) {
            const runsInLatestRg = dwr.runs.filter((r: { runGroupId: string | null }) => r.runGroupId === latestRg?.id)
            console.log(`[sse:environment:debug] workspace=${dwr.preview.workspacePath} totalRuns=${dwr.runs.length} runsInLatestRg=${runsInLatestRg.length}`)
          }

          const elapsed = Date.now() - start
          getSseSnapshotDurationHistogram().record(elapsed, { type: "environment" })

          const payload = JSON.stringify({ data: snapshot })

          if (payload !== lastPayload) {
            lastPayload = payload
            getSsePayloadBytesHistogram().record(payload.length, { type: "environment" })
            getSseMessagesSentCounter().add(1, { type: "snapshot" })
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
      await sendSnapshot()

      // Listen for deployment updates matching this environment
      const handleDeploymentUpdate = (event: DeploymentUpdateEvent): void => {
        if (
          event.orgId === auth.orgId &&
          event.repo === repo &&
          event.environmentName === environmentName
        ) {
          sendSnapshot().catch((err) => console.error(`[sse:environment] error in handleDeploymentUpdate:`, err))
        }
      }

      // Listen for run updates for any deployment in this environment
      const handleRunUpdate = (event: RunUpdateEvent): void => {
        if (deploymentIds.has(event.previewId)) {
          sendSnapshot().catch((err) => console.error(`[sse:environment] error in handleRunUpdate:`, err))
        }
      }

      events.onDeploymentUpdate(handleDeploymentUpdate)
      events.onRunUpdate(handleRunUpdate)
      console.log(`[sse:environment] connected: ${environmentName}`)

      // Heartbeat to keep connection alive
      const heartbeat = setInterval(() => {
        stream.writeSSE({ event: "heartbeat", data: JSON.stringify({ ts: Date.now() }) })
          .catch(() => { /* connection likely closed */ })
      }, 30_000)

      // Block until client disconnects
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          console.log(`[sse:environment] onAbort called: ${environmentName}`)
          getSseConnectionsActiveCounter().add(-1, { type: "environment" })
          clearInterval(heartbeat)
          events.offDeploymentUpdate(handleDeploymentUpdate)
          events.offRunUpdate(handleRunUpdate)
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

function filterRunGroupsByHeadSha(
  runGroups: RunGroup[],
  headSha?: string,
): RunGroup[] {
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
  stateKey: string
  mode: string
  requireApproval: boolean
  createdAt: string
}

function serializePreview(p: {
  id: string
  workspacePath: string
  status: string
  stateKey: string
  mode: string
  requireApproval: boolean
  createdAt: Date
  blockedReason?: string | null
}, readiness: {
  status: "ready" | "missing" | "conflict" | "not_required"
  missingProviders: string[]
  conflictProviders: string[]
  matchedConnections: Array<{ id: string; name: string; provider: string }>
}): SerializedPreview {
  return {
    id: p.id,
    workspacePath: p.workspacePath,
    status: p.status,
    connectionStatus: readiness.status,
    missingProviders: readiness.missingProviders,
    conflictProviders: readiness.conflictProviders,
    matchedConnections: readiness.matchedConnections,
    blockedReason: p.blockedReason ?? null,
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
  logOutput: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
}

function serializeRun(r: {
  id: string
  deploymentId: string
  runGroupId: string | null
  runType: string
  status: string
  checkRunId: number | null
  planSummary: string | null
  outputs: unknown
  errorMessage: string | null
  logOutput: string | null
  startedAt: Date | null
  completedAt: Date | null
  createdAt: Date
}): SerializedRun {
  return {
    id: r.id,
    deploymentId: r.deploymentId,
    runGroupId: r.runGroupId,
    runType: r.runType,
    status: r.status,
    checkRunId: r.checkRunId,
    planSummary: r.planSummary,
    outputs: r.outputs,
    errorMessage: r.errorMessage,
    logOutput: r.logOutput,
    startedAt: r.startedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }
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
  trigger: string
  status: string
  dependencyGraph: SerializedDependencyGraph | null
  systemError: SerializedSystemError | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

function serializeRunGroup(rg: RunGroup): SerializedRunGroup {
  const rawGraph = rg.dependencyGraph as (SerializedDependencyGraph & { systemError?: SerializedSystemError }) | null

  return {
    id: rg.id,
    repo: rg.repo,
    prNumber: rg.prNumber,
    ref: rg.ref,
    headSha: rg.headSha,
    trigger: rg.trigger,
    status: rg.status,
    dependencyGraph: rawGraph
      ? {
          workspaces: rawGraph.workspaces,
          edges: rawGraph.edges,
        }
      : null,
    systemError: rawGraph?.systemError ?? null,
    createdAt: rg.createdAt.toISOString(),
    startedAt: rg.startedAt?.toISOString() ?? null,
    completedAt: rg.completedAt?.toISOString() ?? null,
  }
}
