/**
 * Scanner API Routes
 *
 * Endpoints for the scanner worker to claim scan jobs, send heartbeats,
 * and report scan results. Uses scan job tokens (JWTs) for authentication.
 *
 * When the scanner reports completion, the complete endpoint handles
 * the continuation: creating deployments, setting upstream relationships,
 * creating check runs, and queuing plan jobs.
 */

import { Hono } from "hono"

import { verifyScanJobToken, type ScanJobTokenPayload } from "../lib/job-token.ts"
import { logger } from "../lib/telemetry.ts"
import {
  claimScanJob,
  completeScanJob,
  failScanJob,
  heartbeatScanJob,
  type ScanJobResult,
} from "../db/queries/scan-jobs.ts"
import { updateRunGroupStatus } from "../db/queries/run-groups.ts"
import { completeRunGroupCheck } from "../lib/run-group-checks.ts"
import { completeRunGroup } from "../lib/run-group-orchestrator.ts"
import { createWorkspaceCache } from "../lib/workspace-cache.ts"

const scanner = new Hono()

/**
 * Middleware: verify scan job token from Authorization header.
 */
async function verifyScanToken(c: any): Promise<ScanJobTokenPayload | null> {
  const authHeader = c.req.header("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return null
  }

  const token = authHeader.slice(7)
  return verifyScanJobToken(token)
}

/**
 * POST /claim
 *
 * Claim a scan job. Returns the inputs the scanner needs:
 * repo URL, SHA, installation token, and a presigned S3 upload URL.
 */
scanner.post("/claim", async (c) => {
  const payload = await verifyScanToken(c)
  if (!payload) {
    return c.json({ error: "Invalid or expired scan token" }, 401)
  }

  const scanJobId = payload.scan_job_id
  const workerId = c.req.header("x-worker-id") ?? `scanner-${Date.now()}`

  const { claimed, job } = await claimScanJob(scanJobId, workerId)
  if (!claimed || !job) {
    return c.json({ error: "Job already claimed or not found" }, 409)
  }

  // Generate presigned S3 upload URL for workspace tarball
  let workspaceUploadUrl: string | undefined
  try {
    const cache = createWorkspaceCache()
    const s3Key = `${job.orgSlug}/${job.ref.replace("refs/heads/", "")}/${job.headSha}/workspace.tar.gz`
    workspaceUploadUrl = await cache.getUploadUrl(s3Key)
  } catch (err) {
    logger.warn("Failed to generate workspace upload URL", {
      scanJobId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return c.json({
    scanJobId: job.id,
    runGroupId: job.runGroupId,
    repoUrl: job.repoUrl,
    ref: job.ref,
    headSha: job.headSha,
    installationToken: job.installationToken,
    orgSlug: job.orgSlug,
    workspacePaths: job.workspacePaths as string[],
    workspaceVariables: (job.workspaceVariables as Record<string, Record<string, string | number | boolean>>) ?? {},
    workspaceUploadUrl,
  })
})

/**
 * POST /heartbeat
 *
 * Update heartbeat for a running scan job.
 */
scanner.post("/heartbeat", async (c) => {
  const payload = await verifyScanToken(c)
  if (!payload) {
    return c.json({ error: "Invalid or expired scan token" }, 401)
  }

  const alive = await heartbeatScanJob(payload.scan_job_id)

  return c.json({ continue: alive })
})

/**
 * POST /complete
 *
 * Report scan completion. On success, triggers the run group completion flow:
 * creates deployments, sets upstreams, queues plan jobs.
 */
scanner.post("/complete", async (c) => {
  const payload = await verifyScanToken(c)
  if (!payload) {
    return c.json({ error: "Invalid or expired scan token" }, 401)
  }

  const body = await c.req.json()
  const scanJobId = payload.scan_job_id

  if (body.error) {
    // Scanner failed
    const failedJob = await failScanJob(scanJobId, body.error)

    if (failedJob) {
      await updateRunGroupStatus(failedJob.runGroupId, "failed", { completedAt: new Date() })
      await completeRunGroupCheck({
        runGroupId: failedJob.runGroupId,
        conclusion: "failure",
        summary: body.error,
      })
    }

    logger.error("Scanner reported failure", {
      scanJobId,
      error: body.error,
    })

    return c.json({ ok: true })
  }

  // Scanner succeeded — store result
  const result: ScanJobResult = {
    graph: body.graph,
    executionOrder: body.executionOrder,
    workspaceS3Key: body.workspaceS3Key,
  }

  const job = await completeScanJob(scanJobId, result)
  if (!job) {
    return c.json({ error: "Job not found or not running" }, 409)
  }

  // Trigger the run group completion flow
  try {
    await completeRunGroup(job.runGroupId, result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await updateRunGroupStatus(job.runGroupId, "failed", { completedAt: new Date() })
    await completeRunGroupCheck({
      runGroupId: job.runGroupId,
      conclusion: "failure",
      summary: message,
    })

    logger.error("Failed to complete run group after scan", {
      scanJobId,
      runGroupId: job.runGroupId,
      error: message,
    })
    // Don't fail the scanner response — the scan itself succeeded
  }

  return c.json({ ok: true })
})

export { scanner as scannerRoute }
