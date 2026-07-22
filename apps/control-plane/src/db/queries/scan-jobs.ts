import { and, desc, eq, lt, or, isNull } from "drizzle-orm"

import type {
  AutomaticIsolationArtifactManifest,
  AutomaticIsolationPreflight,
  WorkspaceModuleOutputReference,
} from "@yaffle/shared"

import type { WorkspaceVariablesByPath } from "../../lib/workspace-variables.ts"

import { db } from "../../lib/db.ts"
import { scanJobs } from "../schema.ts"
import { withDbSpan, logger } from "../../lib/telemetry.ts"
import { isStaleScanJob } from "./scan-job-staleness.ts"

export type ScanJob = typeof scanJobs.$inferSelect

export interface ScanJobResult {
  graph: { workspaces: string[]; edges: [string, string][] }
  executionOrder: string[]
  moduleOutputReferences?: WorkspaceModuleOutputReference[]
  workspaceS3Key?: string
  workspaceArtifactSha256?: string
  automaticIsolationPreflight?: AutomaticIsolationPreflight
  automaticIsolationArtifacts?: AutomaticIsolationArtifactManifest[]
}

/**
 * Create a new scan job.
 */
export async function createScanJob(values: {
  runGroupId: string
  orgId: string
  repoUrl: string
  ref: string
  headSha: string
  installationToken?: string
  orgSlug: string
  workspacePaths: string[]
  workspaceVariables?: WorkspaceVariablesByPath
  automaticIsolationWorkspacePaths?: string[]
}): Promise<ScanJob> {
  return withDbSpan("insert", "scan_jobs", async () => {
    const rows = await db
      .insert(scanJobs)
      .values({
        runGroupId: values.runGroupId,
        orgId: values.orgId,
        repoUrl: values.repoUrl,
        ref: values.ref,
        headSha: values.headSha,
        installationToken: values.installationToken ?? null,
        orgSlug: values.orgSlug,
        workspacePaths: values.workspacePaths,
        workspaceVariables: values.workspaceVariables ?? {},
        automaticIsolationWorkspacePaths: values.automaticIsolationWorkspacePaths ?? [],
      })
      .returning()

    const job = rows[0]
    logger.info("scan_job.created", {
      "scan_job.id": job.id,
      "scan_job.run_group_id": job.runGroupId,
    })

    return job
  })
}

/**
 * Atomically claim a scan job for a worker.
 * Transitions from "queued" to "running".
 */
export async function claimScanJob(
  jobId: string,
  workerId: string,
): Promise<{ claimed: boolean; job?: ScanJob }> {
  return withDbSpan("update", "scan_jobs", async () => {
    const rows = await db
      .update(scanJobs)
      .set({
        status: "running",
        workerId,
        startedAt: new Date(),
        lastHeartbeat: new Date(),
      })
      .where(and(eq(scanJobs.id, jobId), eq(scanJobs.status, "queued")))
      .returning()

    const job = rows[0]
    if (job) {
      logger.info("scan_job.claimed", {
        "scan_job.id": job.id,
        "scan_job.worker_id": workerId,
      })
    }

    return { claimed: !!job, job }
  })
}

/**
 * Complete a scan job with result.
 */
export async function completeScanJob(
  jobId: string,
  result: ScanJobResult,
): Promise<ScanJob | undefined> {
  return withDbSpan("update", "scan_jobs", async () => {
    const rows = await db
      .update(scanJobs)
      .set({
        status: "completed",
        result,
        completedAt: new Date(),
      })
      .where(and(eq(scanJobs.id, jobId), eq(scanJobs.status, "running")))
      .returning()

    const job = rows[0]
    if (job) {
      logger.info("scan_job.completed", {
        "scan_job.id": job.id,
        "scan_job.run_group_id": job.runGroupId,
      })
    }

    return job
  })
}

/**
 * Fail a scan job with error message.
 */
export async function failScanJob(
  jobId: string,
  errorMessage: string,
): Promise<ScanJob | undefined> {
  return withDbSpan("update", "scan_jobs", async () => {
    const rows = await db
      .update(scanJobs)
      .set({
        status: "failed",
        errorMessage,
        completedAt: new Date(),
      })
      .where(and(eq(scanJobs.id, jobId), eq(scanJobs.status, "running")))
      .returning()

    const job = rows[0]
    if (job) {
      logger.error("scan_job.failed", {
        "scan_job.id": job.id,
        "scan_job.error": errorMessage,
      })
    }

    return job
  })
}

/**
 * Mark a stale scan job as failed.
 *
 * Handles both:
 * - queued jobs that were never claimed
 * - running jobs whose heartbeat expired
 *
 * Uses a row lock to avoid racing with claim/heartbeat/complete updates.
 */
export async function failStaleScanJob(
  jobId: string,
  staleThresholdMs: number,
  errorMessage: string,
): Promise<{ failed: boolean; job?: ScanJob }> {
  return withDbSpan("update", "scan_jobs", async () => {
    return db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(scanJobs)
        .where(eq(scanJobs.id, jobId))
        .for("update")
        .limit(1)

      const job = rows[0]
      if (!job) {
        return { failed: false }
      }

      const now = new Date()
      if (!isStaleScanJob(job, staleThresholdMs, now)) {
        return { failed: false, job }
      }

      const updatedRows = await tx
        .update(scanJobs)
        .set({
          status: "failed",
          errorMessage,
          completedAt: now,
        })
        .where(eq(scanJobs.id, jobId))
        .returning()

      const updatedJob = updatedRows[0]

      if (!updatedJob) {
        return { failed: false, job }
      }

      logger.error("scan_job.failed", {
        "scan_job.id": updatedJob.id,
        "scan_job.error": errorMessage,
      })

      return { failed: true, job: updatedJob }
    })
  })
}

/**
 * Update heartbeat for a running scan job.
 */
export async function heartbeatScanJob(jobId: string): Promise<boolean> {
  return withDbSpan("update", "scan_jobs", async () => {
    const rows = await db
      .update(scanJobs)
      .set({ lastHeartbeat: new Date() })
      .where(and(eq(scanJobs.id, jobId), eq(scanJobs.status, "running")))
      .returning({ id: scanJobs.id })

    return rows.length > 0
  })
}

/**
 * Find a scan job by ID.
 */
export async function findScanJobById(id: string): Promise<ScanJob | undefined> {
  return withDbSpan("select", "scan_jobs", async () => {
    const rows = await db.select().from(scanJobs).where(eq(scanJobs.id, id)).limit(1)

    return rows[0]
  })
}

export async function findLatestScanJobByRunGroup(
  runGroupId: string,
): Promise<ScanJob | undefined> {
  const rows = await db
    .select()
    .from(scanJobs)
    .where(eq(scanJobs.runGroupId, runGroupId))
    .orderBy(desc(scanJobs.queuedAt))
    .limit(1)

  return rows[0]
}

/**
 * Find stale scan jobs:
 * - Running jobs with no heartbeat within threshold
 * - Queued jobs that were never claimed within threshold (spawner failure)
 */
export async function findStaleScanJobs(thresholdMs: number): Promise<ScanJob[]> {
  return withDbSpan("select", "scan_jobs", async () => {
    const cutoff = new Date(Date.now() - thresholdMs)

    return db
      .select()
      .from(scanJobs)
      .where(
        or(
          // Running but heartbeat went stale
          and(eq(scanJobs.status, "running"), lt(scanJobs.lastHeartbeat, cutoff)),
          // Queued but never claimed (no heartbeat, queued before cutoff)
          and(
            eq(scanJobs.status, "queued"),
            isNull(scanJobs.lastHeartbeat),
            lt(scanJobs.queuedAt, cutoff),
          ),
        ),
      )
  })
}
