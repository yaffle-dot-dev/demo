import { createIacJob } from "../db/queries/iac-jobs.ts"
import {
  addCompletedUpstreamAtomic,
  claimDestroyJobForUpstream,
  findDeploymentById,
  findDownstreamDeployments,
  markDeploymentSkipped,
} from "../db/queries/workspace-deployments.ts"
import { logger } from "./telemetry.ts"

export async function notifyDownstreams(
  deploymentId: string,
  completedJobType: string,
  runGroupId?: string | null,
): Promise<void> {
  if (completedJobType !== "apply") {
    return
  }

  const downstreams = await findDownstreamDeployments(deploymentId)
  if (downstreams.length === 0) {
    logger.debug("No downstream previews to notify", { deploymentId })
    return
  }

  logger.info("Notifying downstream previews", {
    deploymentId,
    downstreamCount: downstreams.length,
    downstreamIds: downstreams.map((p) => p.id),
  })

  for (const downstream of downstreams) {
    const result = await addCompletedUpstreamAtomic(downstream.id, deploymentId)
    if (!result) {
      logger.warn("Failed to update downstream completed_upstreams", {
        deploymentId,
        downstreamId: downstream.id,
      })
      continue
    }

    if (result.shouldQueueJob) {
      logger.info("Downstream preview now ready, queueing plan (won race)", {
        downstreamId: downstream.id,
        workspacePath: result.deployment.workspacePath,
      })

      await createIacJob({
        deploymentId: downstream.id,
        runGroupId,
        jobType: "plan",
      })
    }
  }
}

export async function cascadeFailure(deploymentId: string): Promise<void> {
  const downstreams = await findDownstreamDeployments(deploymentId)
  if (downstreams.length === 0) {
    return
  }

  logger.info("Cascading failure to downstream previews", {
    deploymentId,
    downstreamCount: downstreams.length,
  })

  const upstream = await findDeploymentById(deploymentId)
  const reason = `Skipped: upstream ${upstream?.workspacePath ?? deploymentId} failed`

  const visited = new Set<string>()
  const toProcess = [...downstreams]

  while (toProcess.length > 0) {
    const downstream = toProcess.shift()!
    if (visited.has(downstream.id)) continue
    visited.add(downstream.id)

    if (["failed", "destroyed", "ready"].includes(downstream.status)) {
      continue
    }

    await markDeploymentSkipped(downstream.id, reason)

    const transitiveDownstreams = await findDownstreamDeployments(downstream.id)
    for (const transitive of transitiveDownstreams) {
      if (!visited.has(transitive.id)) {
        toProcess.push(transitive)
      }
    }
  }
}

export async function notifyDestroyComplete(
  deploymentId: string,
): Promise<void> {
  const deployment = await findDeploymentById(deploymentId)
  if (!deployment || !deployment.upstreamIds || deployment.upstreamIds.length === 0) {
    return
  }

  for (const upstreamId of deployment.upstreamIds) {
    const downstreams = await findDownstreamDeployments(upstreamId)
    const allDestroyed = downstreams.every((d) => d.status === "destroyed")

    if (!allDestroyed) {
      continue
    }

    const result = await claimDestroyJobForUpstream(upstreamId)
    if (result.claimed && result.deployment) {
      await createIacJob({
        deploymentId: upstreamId,
        jobType: "destroy",
      })
    }
  }
}
