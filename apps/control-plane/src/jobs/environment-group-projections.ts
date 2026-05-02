import { z } from "zod"

import {
  createJob,
  findActiveProjectionRebuildJob,
  type Job,
} from "../db/queries/jobs.ts"
import { rebuildEnvironmentGroupProjections } from "../lib/projections/environment-groups.ts"
import { logger } from "../lib/telemetry.ts"

const rebuildEnvironmentGroupProjectionsPayloadSchema = z.object({
  orgId: z.string().uuid(),
  repo: z.string().min(1).optional(),
  environmentKind: z.enum(["named", "transient"]).optional(),
  environmentName: z.string().min(1).optional(),
})

export type RebuildEnvironmentGroupProjectionsPayload = z.infer<
  typeof rebuildEnvironmentGroupProjectionsPayloadSchema
>

export async function enqueueEnvironmentGroupProjectionRebuild(
  payload: RebuildEnvironmentGroupProjectionsPayload,
): Promise<void> {
  const existing = await findActiveProjectionRebuildJob(payload)
  if (existing) {
    return
  }

  await createJob({
    orgId: payload.orgId,
    jobType: "rebuild_environment_group_projections",
    payload,
  })
}

export async function handleEnvironmentGroupProjectionRebuildJob(job: Job): Promise<void> {
  const parsed = rebuildEnvironmentGroupProjectionsPayloadSchema.safeParse(job.payload)
  if (!parsed.success) {
    throw new Error(`Invalid rebuild_environment_group_projections payload for job ${job.id}`)
  }

  const payload = parsed.data
  const rebuilt = await rebuildEnvironmentGroupProjections(payload)

  logger.info("projection.rebuild.completed", {
    jobId: job.id,
    projectionType: "environment_group",
    orgId: payload.orgId,
    repo: payload.repo,
    environmentKind: payload.environmentKind,
    environmentName: payload.environmentName,
    rebuiltCount: rebuilt,
  })
}
