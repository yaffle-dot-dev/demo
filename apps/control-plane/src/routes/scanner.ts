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
import { z } from "zod"

import { verifyScanJobToken, type ScanJobTokenPayload } from "../lib/job-token.ts"
import { logger } from "../lib/telemetry.ts"
import {
  claimScanJob,
  completeScanJob,
  failScanJob,
  findScanJobById,
  heartbeatScanJob,
  type ScanJobResult,
} from "../db/queries/scan-jobs.ts"
import { updateRunGroupStatus } from "../db/queries/run-groups.ts"
import { completeRunGroupCheck } from "../lib/run-group-checks.ts"
import { completeRunGroup } from "../lib/run-group-orchestrator.ts"
import { createWorkspaceCache } from "../lib/workspace-cache.ts"
import {
  getAutomaticIsolationPreflightOutcome,
  validateAutomaticIsolationPreflightCoverage,
} from "../lib/automatic-preview-isolation-preflight.ts"

const MAX_SCAN_COMPLETION_BODY_BYTES = 1_000_000

interface ScannerRouteDependencies {
  verifyScanJobToken: typeof verifyScanJobToken
  claimScanJob: typeof claimScanJob
  completeScanJob: typeof completeScanJob
  failScanJob: typeof failScanJob
  findScanJobById: typeof findScanJobById
  heartbeatScanJob: typeof heartbeatScanJob
  updateRunGroupStatus: typeof updateRunGroupStatus
  completeRunGroupCheck: typeof completeRunGroupCheck
  completeRunGroup: typeof completeRunGroup
  createWorkspaceCache: typeof createWorkspaceCache
}

const defaultDependencies: ScannerRouteDependencies = {
  verifyScanJobToken,
  claimScanJob,
  completeScanJob,
  failScanJob,
  findScanJobById,
  heartbeatScanJob,
  updateRunGroupStatus,
  completeRunGroupCheck,
  completeRunGroup,
  createWorkspaceCache,
}

const automaticIsolationFindingSchema = z.object({
  code: z.enum([
    "hcl_parse_error",
    "import_not_allowed",
    "module_review_required",
    "prevent_destroy_not_allowed",
    "provisioner_not_allowed",
    "removed_not_allowed",
    "resource_review_required",
    "symlink_not_supported",
    "tf_json_not_supported",
  ]),
  filePath: z.string().min(1).max(1024),
  resourceAddress: z.string().min(1).max(512).optional(),
  message: z.string().min(1).max(4096),
})

const automaticIsolationWorkspacePreflightSchema = z.object({
  workspacePath: z.string().min(1),
  status: z.enum(["ready", "review_required", "blocked"]),
  findings: z.array(automaticIsolationFindingSchema).max(5000),
})

const automaticIsolationPreflightSchema = z.object({
  status: z.enum(["ready", "review_required", "blocked"]),
  workspaces: z.array(automaticIsolationWorkspacePreflightSchema).max(1000),
})

const scanCompletionSchema = z.union([
  z.object({ error: z.string().min(1) }).strict(),
  z
    .object({
      graph: z.object({
        workspaces: z.array(z.string().min(1).max(1024)).max(1000),
        edges: z
          .array(z.tuple([z.string().min(1).max(1024), z.string().min(1).max(1024)]))
          .max(10000),
      }),
      executionOrder: z.array(z.string().min(1).max(1024)).max(1000),
      workspaceS3Key: z.string().min(1).max(2048).optional(),
      automaticIsolationPreflight: automaticIsolationPreflightSchema.optional(),
    })
    .strict(),
])

async function readBoundedJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SCAN_COMPLETION_BODY_BYTES) {
    throw new Error("request body too large")
  }

  if (!request.body) {
    throw new Error("request body is required")
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_SCAN_COMPLETION_BODY_BYTES) {
      await reader.cancel()
      throw new Error("request body too large")
    }
    chunks.push(value)
  }

  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  return JSON.parse(new TextDecoder().decode(body)) as unknown
}

/**
 * Middleware: verify scan job token from Authorization header.
 */
async function verifyScanToken(
  c: any,
  verify: typeof verifyScanJobToken,
): Promise<ScanJobTokenPayload | null> {
  const authHeader = c.req.header("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return null
  }

  const token = authHeader.slice(7)
  return verify(token)
}

export function createScannerRoute(overrides: Partial<ScannerRouteDependencies> = {}): Hono {
  const deps = { ...defaultDependencies, ...overrides }
  const scanner = new Hono()

  /**
   * POST /claim
   *
   * Claim a scan job. Returns the inputs the scanner needs:
   * repo URL, SHA, installation token, and a presigned S3 upload URL.
   */
  scanner.post("/claim", async (c) => {
    const payload = await verifyScanToken(c, deps.verifyScanJobToken)
    if (!payload) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Invalid or expired scan token" } },
        401,
      )
    }

    const scanJobId = payload.scan_job_id
    const workerId = c.req.header("x-worker-id") ?? `scanner-${Date.now()}`
    const queuedJob = await deps.findScanJobById(scanJobId)
    if (!queuedJob || queuedJob.orgId !== payload.org_id) {
      return c.json({ error: { code: "NOT_FOUND", message: "Job not found" } }, 404)
    }

    const { claimed, job } = await deps.claimScanJob(scanJobId, workerId)
    if (!claimed || !job) {
      return c.json(
        { error: { code: "CONFLICT", message: "Job already claimed or not found" } },
        409,
      )
    }

    // Generate presigned S3 upload URL for workspace tarball
    let workspaceUploadUrl: string | undefined
    try {
      const cache = deps.createWorkspaceCache()
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
      workspaceVariables:
        (job.workspaceVariables as Record<string, Record<string, string | number | boolean>>) ?? {},
      automaticIsolationWorkspacePaths: (job.automaticIsolationWorkspacePaths as string[]) ?? [],
      workspaceUploadUrl,
    })
  })

  /**
   * POST /heartbeat
   *
   * Update heartbeat for a running scan job.
   */
  scanner.post("/heartbeat", async (c) => {
    const payload = await verifyScanToken(c, deps.verifyScanJobToken)
    if (!payload) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Invalid or expired scan token" } },
        401,
      )
    }

    const job = await deps.findScanJobById(payload.scan_job_id)
    if (!job || job.orgId !== payload.org_id) {
      return c.json({ error: { code: "NOT_FOUND", message: "Job not found" } }, 404)
    }

    const alive = await deps.heartbeatScanJob(payload.scan_job_id)

    return c.json({ continue: alive })
  })

  /**
   * POST /complete
   *
   * Report scan completion. On success, triggers the run group completion flow:
   * creates deployments, sets upstreams, queues plan jobs.
   */
  scanner.post("/complete", async (c) => {
    const payload = await verifyScanToken(c, deps.verifyScanJobToken)
    if (!payload) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Invalid or expired scan token" } },
        401,
      )
    }

    const scanJobId = payload.scan_job_id
    const runningJob = await deps.findScanJobById(scanJobId)
    if (!runningJob || runningJob.orgId !== payload.org_id) {
      return c.json({ error: { code: "NOT_FOUND", message: "Job not found" } }, 404)
    }

    let rawBody: unknown
    try {
      rawBody = await readBoundedJson(c.req.raw)
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid request body"
      const tooLarge = message === "request body too large"
      return c.json(
        {
          error: {
            code: tooLarge ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST",
            message,
          },
        },
        tooLarge ? 413 : 400,
      )
    }

    const parsedBody = scanCompletionSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return c.json(
        { error: { code: "INVALID_REQUEST", message: "Invalid scan completion payload" } },
        400,
      )
    }
    const body = parsedBody.data

    if ("error" in body) {
      // Scanner failed
      const failedJob = await deps.failScanJob(scanJobId, body.error)

      if (failedJob) {
        await deps.updateRunGroupStatus(failedJob.runGroupId, "failed", { completedAt: new Date() })
        await deps.completeRunGroupCheck({
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
      automaticIsolationPreflight: body.automaticIsolationPreflight,
    }

    if (runningJob.status !== "running") {
      return c.json({ error: { code: "CONFLICT", message: "Job not found or not running" } }, 409)
    }

    const coverageError = validateAutomaticIsolationPreflightCoverage(
      (runningJob.automaticIsolationWorkspacePaths as string[]) ?? [],
      result.automaticIsolationPreflight,
    )
    if (coverageError) {
      const failedJob = await deps.failScanJob(scanJobId, coverageError)
      if (failedJob) {
        await deps.updateRunGroupStatus(failedJob.runGroupId, "failed", { completedAt: new Date() })
        await deps.completeRunGroupCheck({
          runGroupId: failedJob.runGroupId,
          conclusion: "failure",
          title: "Automatic preview isolation preflight failed",
          summary: `${coverageError}. No Terraform plan was created.`,
        })
      }
      return c.json({ ok: true })
    }

    const job = await deps.completeScanJob(scanJobId, result)
    if (!job) {
      return c.json({ error: { code: "CONFLICT", message: "Job not found or not running" } }, 409)
    }

    const isolationOutcome = getAutomaticIsolationPreflightOutcome(
      result.automaticIsolationPreflight,
    )
    if (isolationOutcome) {
      await deps.updateRunGroupStatus(job.runGroupId, isolationOutcome.runGroupStatus, {
        completedAt: new Date(),
      })
      await deps.completeRunGroupCheck({
        runGroupId: job.runGroupId,
        conclusion: isolationOutcome.conclusion,
        title: isolationOutcome.title,
        summary: isolationOutcome.summary,
      })
      return c.json({ ok: true })
    }

    // Trigger the run group completion flow
    try {
      await deps.completeRunGroup(job.runGroupId, result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await deps.updateRunGroupStatus(job.runGroupId, "failed", { completedAt: new Date() })
      await deps.completeRunGroupCheck({
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

  return scanner
}

export const scannerRoute = createScannerRoute()
