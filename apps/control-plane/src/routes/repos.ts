import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"

import {
  findDeploymentsByEnvironment,
} from "../db/queries/workspace-deployments.ts"
import { listRunsForPreview, findLatestRun } from "../db/queries/tf-runs.ts"
import {
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

const prNumberParam = z.coerce.number().int().positive()

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

    if (deployments.length === 0) {
      return c.json(
        { error: { code: "NOT_FOUND", message: `no previews found for PR #${prNumber}` } },
        404,
      )
    }

    // Fetch runs for each deployment
    const deploymentsWithRuns = await Promise.all(
      deployments.map(async (deployment) => {
        const runs = await listRunsForPreview(deployment.id)
        const latestApply = await findLatestRun(deployment.id, "apply")
        const outputs = latestApply?.status === "success" ? latestApply.outputs : null
        return {
          preview: serializePreview(deployment),
          runs: runs.map(serializeRun),
          outputs,
        }
      }),
    )

    // Fetch run groups for this PR
    const runGroupsData = await listRunGroupsForPr(auth.orgId, repo, prNumber)

    // Get metadata from first deployment
    const first = deployments[0]

    return c.json({
      data: {
        org: c.req.param("org"),
        repo,
        prNumber,
        branch: first.branch,
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

          if (deployments.length === 0) {
            const emptyPayload = JSON.stringify({ data: null })
            if (emptyPayload !== lastPayload) {
              lastPayload = emptyPayload
              await stream.writeSSE({ event: "update", data: emptyPayload })
            }
            return
          }

          const deploymentsWithRuns = await Promise.all(
            deployments.map(async (deployment) => {
              const runs = await listRunsForPreview(deployment.id)
              const latestApply = await findLatestRun(deployment.id, "apply")
              const outputs = latestApply?.status === "success" ? latestApply.outputs : null
              return {
                preview: serializePreview(deployment),
                runs: runs.map(serializeRun),
                outputs,
              }
            }),
          )

          // Fetch run groups for this PR
          const runGroupsData = await listRunGroupsForPr(auth.orgId, repo, prNumber)

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
              branch: first.branch,
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

    if (deployments.length === 0) {
      return c.json(
        { error: { code: "NOT_FOUND", message: `no previews found for branch ${branch}` } },
        404,
      )
    }

    // Fetch runs for each deployment
    const deploymentsWithRuns = await Promise.all(
      deployments.map(async (deployment) => {
        const runs = await listRunsForPreview(deployment.id)
        const latestApply = await findLatestRun(deployment.id, "apply")
        const outputs = latestApply?.status === "success" ? latestApply.outputs : null
        return {
          preview: serializePreview(deployment),
          runs: runs.map(serializeRun),
          outputs,
        }
      }),
    )

    // Fetch run groups for this branch
    const runGroupsData = await listRunGroupsForBranch(auth.orgId, repo, branch)

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

          if (deployments.length === 0) {
            const emptyPayload = JSON.stringify({ data: null })
            if (emptyPayload !== lastPayload) {
              lastPayload = emptyPayload
              await stream.writeSSE({ event: "update", data: emptyPayload })
            }
            return
          }

          const deploymentsWithRuns = await Promise.all(
            deployments.map(async (deployment) => {
              const runs = await listRunsForPreview(deployment.id)
              const latestApply = await findLatestRun(deployment.id, "apply")
              const outputs = latestApply?.status === "success" ? latestApply.outputs : null
              return {
                preview: serializePreview(deployment),
                runs: runs.map(serializeRun),
                outputs,
              }
            }),
          )

          // Fetch run groups for this branch
          const runGroupsData = await listRunGroupsForBranch(auth.orgId, repo, branch)

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
    const repo = c.req.param("repo")
    const environmentName = c.req.param("name")
    if (!repo || !environmentName) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "repo and environment name are required" } }, 400)
    }

    const deployments = await findDeploymentsByEnvironment(auth.orgId, repo, environmentName)

    if (deployments.length === 0) {
      return c.json(
        { error: { code: "NOT_FOUND", message: `no deployments found for environment ${environmentName}` } },
        404,
      )
    }

    // Fetch runs for each deployment
    const deploymentsWithRuns = await Promise.all(
      deployments.map(async (deployment) => {
        const runs = await listRunsForPreview(deployment.id)
        const latestApply = await findLatestRun(deployment.id, "apply")
        const outputs = latestApply?.status === "success" ? latestApply.outputs : null
        return {
          preview: serializePreview(deployment),
          runs: runs.map(serializeRun),
          outputs,
        }
      }),
    )

    // Fetch run groups for this environment
    const runGroupsData = await listRunGroupsForEnvironment(auth.orgId, repo, environmentName)

    const first = deployments[0]

    return c.json({
      data: {
        org: c.req.param("org"),
        repo,
        environmentKind: first.environmentKind,
        environmentName: first.environmentName,
        branch: first.branch,
        headSha: first.headSha,
        prNumber: first.prNumber,
        authorGithubId: first.authorGithubId,
        authorLogin: first.authorLogin,
        workspaces: deploymentsWithRuns,
        runGroups: runGroupsData.map(serializeRunGroup),
      },
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
    const repo = c.req.param("repo")
    const environmentName = c.req.param("name")
    if (!repo || !environmentName) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "repo and environment name are required" } }, 400)
    }

    return streamSSE(c, async (stream) => {
      getSseConnectionsActiveCounter().add(1, { type: "environment" })
      let lastPayload = ""
      let inFlight = false
      let pendingUpdate = false

      const sendSnapshot = async (): Promise<void> => {
        if (inFlight) {
          pendingUpdate = true
          return
        }
        inFlight = true

        try {
          const start = Date.now()
          const deployments = await findDeploymentsByEnvironment(auth.orgId, repo, environmentName)
          const deploymentsWithRuns = await Promise.all(
            deployments.map(async (deployment) => {
              const runs = await listRunsForPreview(deployment.id)
              const latestApply = await findLatestRun(deployment.id, "apply")
              const outputs = latestApply?.status === "success" ? latestApply.outputs : null
              return {
                preview: serializePreview(deployment),
                runs: runs.map(serializeRun),
                outputs,
              }
            }),
          )

          const runGroupsData = await listRunGroupsForEnvironment(auth.orgId, repo, environmentName)

          const elapsed = Date.now() - start
          getSseSnapshotDurationHistogram().record(elapsed, { type: "environment" })

          const first = deployments[0]
          const payload = JSON.stringify({
            data: {
              org: c.req.param("org"),
              repo,
              environmentKind: first?.environmentKind ?? "named",
              environmentName,
              branch: first?.branch ?? environmentName,
              headSha: first?.headSha ?? "",
              prNumber: first?.prNumber ?? null,
              authorGithubId: first?.authorGithubId ?? null,
              authorLogin: first?.authorLogin ?? null,
              workspaces: deploymentsWithRuns,
              runGroups: runGroupsData.map(serializeRunGroup),
            },
          })

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

      // Track deployment IDs for this environment to filter events
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
            .catch((err) => console.error(`[sse:environment] error in handleDeploymentUpdate:`, err))
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

interface SerializedPreview {
  id: string
  workspacePath: string
  status: string
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
}): SerializedPreview {
  return {
    id: p.id,
    workspacePath: p.workspacePath,
    status: p.status,
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

interface SerializedDependencyGraph {
  workspaces: string[]
  edges: [string, string][]
}

interface SerializedRunGroup {
  id: string
  repo: string
  prNumber: number | null
  branch: string
  headSha: string
  trigger: string
  status: string
  dependencyGraph: SerializedDependencyGraph | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

function serializeRunGroup(rg: RunGroup): SerializedRunGroup {
  return {
    id: rg.id,
    repo: rg.repo,
    prNumber: rg.prNumber,
    branch: rg.branch,
    headSha: rg.headSha,
    trigger: rg.trigger,
    status: rg.status,
    dependencyGraph: rg.dependencyGraph as SerializedDependencyGraph | null,
    createdAt: rg.createdAt.toISOString(),
    startedAt: rg.startedAt?.toISOString() ?? null,
    completedAt: rg.completedAt?.toISOString() ?? null,
  }
}
