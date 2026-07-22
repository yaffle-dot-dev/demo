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

import {
  computeAutomaticIsolationArtifactHash,
  type AutomaticIsolationArtifactManifest,
  type WorkspaceModuleOutputReference,
} from "@yaffle/shared"

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
import {
  findRunGroupById,
  updateRunGroupStatus,
  type RunGroupDependencyGraph,
} from "../db/queries/run-groups.ts"
import { completeRunGroupCheck } from "../lib/run-group-checks.ts"
import { completeRunGroup } from "../lib/run-group-orchestrator.ts"
import { createWorkspaceCache } from "../lib/workspace-cache.ts"
import { findExecutionSnapshotWorkspace } from "../lib/execution-snapshot.ts"
import {
  getAutomaticIsolationPreflightOutcome,
  validateAutomaticIsolationPreflightCoverage,
} from "../lib/automatic-preview-isolation-preflight.ts"

const MAX_SCAN_COMPLETION_BODY_BYTES = 1_000_000

function workspaceArtifactKey(runGroupId: string): string {
  return `run-groups/${runGroupId}/workspace.tar.gz`
}

function repositoryFromUrl(rawUrl: string): string | null {
  try {
    const parts = new URL(rawUrl).pathname
      .replace(/\.git$/, "")
      .split("/")
      .filter(Boolean)
    return parts.length === 2 ? `${parts[0]}/${parts[1]}`.toLowerCase() : null
  } catch {
    return null
  }
}

function scanFailureGraph(values: {
  workspaces: string[]
  edges?: [string, string][]
  title: string
  summary: string
  filePath?: string
}): RunGroupDependencyGraph {
  return {
    workspaces: values.workspaces,
    edges: values.edges ?? [],
    systemError: {
      kind: "scan",
      title: values.title,
      summary: values.summary,
      filePath: values.filePath ?? "Repository scan",
      line: null,
      column: null,
      excerpt: [],
    },
  }
}

interface ScannerRouteDependencies {
  verifyScanJobToken: typeof verifyScanJobToken
  claimScanJob: typeof claimScanJob
  completeScanJob: typeof completeScanJob
  failScanJob: typeof failScanJob
  findScanJobById: typeof findScanJobById
  heartbeatScanJob: typeof heartbeatScanJob
  findRunGroupById: typeof findRunGroupById
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
  findRunGroupById,
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
    "override_not_allowed",
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

const automaticIsolationArtifactManifestSchema = z
  .object({
    contractVersion: z.literal(1),
    sourceRevision: z.string().min(1).max(128),
    identity: z
      .object({
        organizationId: z.string().min(1).max(128),
        repositoryId: z.string().min(1).max(128),
        workspacePath: z.string().min(1).max(1024),
        environmentKind: z.literal("transient"),
        environmentName: z.string().min(1).max(512),
      })
      .strict(),
    suffix: z.string().regex(/^[a-f0-9]{10}$/),
    strategyRevision: z.string().min(1).max(128),
    naming: z
      .object({
        separator: z.string().min(1).max(8),
        maxLength: z.number().int().positive(),
        allowedPattern: z.string().min(1).max(256),
        collisionScope: z.literal("organization_repository_workspace_environment"),
      })
      .strict()
      .optional(),
    providerLocks: z
      .array(
        z
          .object({
            source: z.string().min(1).max(512),
            version: z.string().min(1).max(128),
            constraints: z.string().max(512).optional(),
            hashes: z.array(z.string().min(1).max(256)).max(100),
          })
          .strict(),
      )
      .max(100),
    transformations: z
      .array(
        z
          .object({
            resourceAddress: z.string().min(1).max(512),
            attribute: z.string().min(1).max(256),
            sourceFile: z.string().min(1).max(1024),
            sourceExpression: z.string().min(1).max(4096),
            strategyRevision: z.string().min(1).max(128),
          })
          .strict(),
      )
      .max(5000),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1024),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(5000),
    artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

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
      moduleOutputReferences: z
        .array(
          z
            .object({
              consumerWorkspacePath: z.string().min(1).max(1024),
              producerWorkspacePath: z.string().min(1).max(1024),
              moduleName: z.string().min(1).max(256),
              outputName: z.string().min(1).max(256),
            })
            .strict(),
        )
        .max(10000)
        .default([]),
      workspaceS3Key: z.string().min(1).max(2048).optional(),
      workspaceArtifactSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      automaticIsolationPreflight: automaticIsolationPreflightSchema.optional(),
      automaticIsolationArtifacts: z
        .array(automaticIsolationArtifactManifestSchema)
        .max(1000)
        .optional(),
    })
    .strict(),
])

function validateModuleOutputReferences(values: {
  references: WorkspaceModuleOutputReference[]
  executionSnapshot: NonNullable<Awaited<ReturnType<typeof findRunGroupById>>>["executionSnapshot"]
}): string | null {
  if (!values.executionSnapshot) {
    return values.references.length === 0
      ? null
      : "module output references are not bound to an execution snapshot"
  }

  const errors: string[] = []
  for (const reference of values.references) {
    const consumer = findExecutionSnapshotWorkspace(
      values.executionSnapshot,
      reference.consumerWorkspacePath,
    )
    const producer = findExecutionSnapshotWorkspace(
      values.executionSnapshot,
      reference.producerWorkspacePath,
    )
    if (!consumer || !producer) {
      errors.push(
        `Reference from "${reference.consumerWorkspacePath}" to "${reference.producerWorkspacePath}" is outside the scanned workspace set`,
      )
      continue
    }
    if (!(reference.outputName in producer.outputs)) {
      errors.push(
        `Workspace "${reference.consumerWorkspacePath}" references undeclared output "${reference.outputName}" from "${reference.producerWorkspacePath}" via module "${reference.moduleName}"; declare outputs.${reference.outputName} on workspace "${reference.producerWorkspacePath}" in yaffle.toml`,
      )
    }
  }

  return errors.length > 0
    ? `Workspace output contract violations:\n- ${errors.join("\n- ")}`
    : null
}

function validateAutomaticIsolationArtifacts(values: {
  workspacePaths: string[]
  artifacts: AutomaticIsolationArtifactManifest[] | undefined
  executionSnapshot: NonNullable<Awaited<ReturnType<typeof findRunGroupById>>>["executionSnapshot"]
  orgId: string
}): string | null {
  const artifacts = values.artifacts ?? []
  if (values.workspacePaths.length === 0) {
    return artifacts.length === 0
      ? null
      : "automatic isolation artifacts were reported for non-opted-in workspaces"
  }
  if (!values.executionSnapshot) {
    return "automatic isolation artifacts are not bound to an execution snapshot"
  }
  if (artifacts.length !== values.workspacePaths.length) {
    return "automatic isolation artifact coverage does not match opted-in workspaces"
  }

  const seenPaths = new Set<string>()
  for (const artifact of artifacts) {
    const workspacePath = artifact.identity.workspacePath
    const workspace = findExecutionSnapshotWorkspace(values.executionSnapshot, workspacePath)
    if (
      seenPaths.has(workspacePath) ||
      !values.workspacePaths.includes(workspacePath) ||
      !workspace?.automaticPreviewIsolation
    ) {
      return `automatic isolation artifact is not authorized for workspace ${workspacePath}`
    }
    seenPaths.add(workspacePath)

    const { artifactHash, ...manifestWithoutHash } = artifact
    if (computeAutomaticIsolationArtifactHash(manifestWithoutHash) !== artifactHash) {
      return `automatic isolation artifact hash is invalid for workspace ${workspacePath}`
    }
    if (
      artifact.identity.organizationId !== values.orgId ||
      artifact.identity.repositoryId !== String(values.executionSnapshot.source.repositoryId) ||
      artifact.identity.environmentKind !== "transient" ||
      artifact.identity.environmentName !== values.executionSnapshot.environment.name ||
      artifact.sourceRevision !== values.executionSnapshot.source.commitSha
    ) {
      return `automatic isolation artifact identity does not match workspace ${workspacePath}`
    }
  }

  return null
}

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
    const runGroup = await deps.findRunGroupById(queuedJob.runGroupId)
    if (!runGroup || runGroup.orgId !== payload.org_id) {
      return c.json({ error: { code: "NOT_FOUND", message: "Run group not found" } }, 404)
    }
    const queuedAutomaticIsolationWorkspacePaths =
      (queuedJob.automaticIsolationWorkspacePaths as string[]) ?? []
    const snapshot = runGroup.executionSnapshot
    const snapshotRepository = snapshot
      ? `${snapshot.source.owner}/${snapshot.source.repository}`.toLowerCase()
      : null
    if (
      queuedAutomaticIsolationWorkspacePaths.length > 0 &&
      (!snapshot ||
        snapshot.environment.kind !== "transient" ||
        snapshot.source.commitSha !== queuedJob.headSha ||
        snapshot.source.ref !== queuedJob.ref ||
        snapshotRepository !== repositoryFromUrl(queuedJob.repoUrl) ||
        runGroup.repo !== snapshot.source.repository ||
        runGroup.environmentKind !== snapshot.environment.kind ||
        runGroup.environmentName !== snapshot.environment.name ||
        queuedAutomaticIsolationWorkspacePaths.some(
          (workspacePath) =>
            !findExecutionSnapshotWorkspace(snapshot, workspacePath)?.automaticPreviewIsolation,
        ))
    ) {
      return c.json(
        {
          error: {
            code: "CONFLICT",
            message: "Automatic preview isolation does not match the immutable execution snapshot",
          },
        },
        409,
      )
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
    const automaticIsolationWorkspacePaths =
      (job.automaticIsolationWorkspacePaths as string[]) ?? []
    const workspaceS3Key = workspaceArtifactKey(job.runGroupId)
    try {
      const cache = deps.createWorkspaceCache()
      workspaceUploadUrl = await cache.getUploadUrl(workspaceS3Key)
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
      automaticIsolationWorkspacePaths,
      automaticIsolationContext:
        automaticIsolationWorkspacePaths.length > 0
          ? {
              organizationId: job.orgId,
              repositoryId: String(runGroup.executionSnapshot!.source.repositoryId),
              environmentKind: "transient" as const,
              environmentName: runGroup.executionSnapshot!.environment.name,
              sourceRevision: runGroup.executionSnapshot!.source.commitSha,
            }
          : undefined,
      workspaceUploadUrl,
      workspaceS3Key,
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
    const runGroup = await deps.findRunGroupById(runningJob.runGroupId)
    if (!runGroup || runGroup.orgId !== payload.org_id) {
      return c.json({ error: { code: "NOT_FOUND", message: "Run group not found" } }, 404)
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
        await deps.updateRunGroupStatus(failedJob.runGroupId, "failed", {
          completedAt: new Date(),
          dependencyGraph: scanFailureGraph({
            workspaces: (runningJob.workspacePaths as string[]) ?? [],
            title: "Repository scan failed",
            summary: body.error,
          }),
        })
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
      moduleOutputReferences: body.moduleOutputReferences,
      workspaceS3Key: body.workspaceS3Key,
      workspaceArtifactSha256: body.workspaceArtifactSha256,
      automaticIsolationPreflight: body.automaticIsolationPreflight,
      automaticIsolationArtifacts: body.automaticIsolationArtifacts,
    }

    if (runningJob.status !== "running") {
      return c.json({ error: { code: "CONFLICT", message: "Job not found or not running" } }, 409)
    }

    const moduleOutputError = validateModuleOutputReferences({
      references: result.moduleOutputReferences ?? [],
      executionSnapshot: runGroup.executionSnapshot,
    })
    if (moduleOutputError) {
      const failedJob = await deps.failScanJob(scanJobId, moduleOutputError)
      if (failedJob) {
        await deps.updateRunGroupStatus(failedJob.runGroupId, "failed", {
          completedAt: new Date(),
          dependencyGraph: scanFailureGraph({
            workspaces: body.graph.workspaces,
            edges: body.graph.edges,
            title: "Workspace output contract validation failed",
            summary: moduleOutputError,
            filePath: "yaffle.toml",
          }),
        })
        await deps.completeRunGroupCheck({
          runGroupId: failedJob.runGroupId,
          conclusion: "failure",
          title: "Workspace output contract validation failed",
          summary: `${moduleOutputError}. No Terraform plan was created.`,
        })
      }
      return c.json({ ok: true })
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

    const isolationOutcome = getAutomaticIsolationPreflightOutcome(
      result.automaticIsolationPreflight,
    )
    const artifactError = !isolationOutcome
      ? (validateAutomaticIsolationArtifacts({
          workspacePaths: (runningJob.automaticIsolationWorkspacePaths as string[]) ?? [],
          artifacts: result.automaticIsolationArtifacts,
          executionSnapshot: runGroup.executionSnapshot,
          orgId: runningJob.orgId,
        }) ??
        (result.workspaceArtifactSha256
          ? null
          : "workspace artifact digest is required before planning"))
      : null
    if (artifactError) {
      const failedJob = await deps.failScanJob(scanJobId, artifactError)
      if (failedJob) {
        await deps.updateRunGroupStatus(failedJob.runGroupId, "failed", { completedAt: new Date() })
        await deps.completeRunGroupCheck({
          runGroupId: failedJob.runGroupId,
          conclusion: "failure",
          title: "Workspace artifact validation failed",
          summary: `${artifactError}. No Terraform plan was created.`,
        })
      }
      return c.json({ ok: true })
    }
    const expectedWorkspaceS3Key = workspaceArtifactKey(runningJob.runGroupId)
    if (!isolationOutcome && body.workspaceS3Key !== expectedWorkspaceS3Key) {
      return c.json(
        {
          error: {
            code: "INVALID_WORKSPACE_ARTIFACT",
            message: "Workspace artifact does not match the scan run group",
          },
        },
        400,
      )
    }

    const job = await deps.completeScanJob(scanJobId, result)
    if (!job) {
      return c.json({ error: { code: "CONFLICT", message: "Job not found or not running" } }, 409)
    }

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
      await deps.updateRunGroupStatus(job.runGroupId, "failed", {
        completedAt: new Date(),
        dependencyGraph: scanFailureGraph({
          workspaces: result.graph.workspaces,
          edges: result.graph.edges,
          title: "Run initialization failed",
          summary: message,
        }),
      })
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
