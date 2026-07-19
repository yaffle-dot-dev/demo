import { and, desc, eq, sql } from "drizzle-orm"

import { db } from "./db.ts"
import { getEnv } from "./env.ts"
import { upsertPrComment } from "./github.ts"
import { isExecutionContextAssociationValid } from "./execution-snapshot.ts"
import { PR_COMMENT_MARKER, renderRunGroupComment } from "./pr-comment.ts"
import { logger } from "./telemetry.ts"
import {
  githubRepoMappings,
  iacJobHistory,
  iacJobs,
  principalRepoBindings,
  runGroups,
  tfRuns,
  workspaceDeployments,
} from "../db/schema.ts"

export async function syncPrCommentForRunGroup(runGroupId: string): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const runGroup = (
        await tx.select().from(runGroups).where(eq(runGroups.id, runGroupId)).limit(1)
      )[0]
      const snapshot = runGroup?.executionSnapshot
      const prNumber = snapshot?.environment.sourcePullRequestNumber
      if (
        !runGroup ||
        !snapshot ||
        snapshot.source.installationId <= 0 ||
        snapshot.environment.kind !== "transient" ||
        prNumber == null
      ) {
        return
      }

      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtext(${`github-pr-comment:${snapshot.source.installationId}:${snapshot.source.repositoryId}:${prNumber}`})
        )
      `)

      const latestRunGroup = (
        await tx
          .select({ id: runGroups.id })
          .from(runGroups)
          .where(
            and(
              eq(runGroups.orgId, runGroup.orgId),
              eq(runGroups.repo, runGroup.repo),
              eq(runGroups.environmentKind, "transient"),
              eq(runGroups.prNumber, prNumber),
            ),
          )
          .orderBy(desc(runGroups.createdAt))
          .limit(1)
      )[0]
      if (latestRunGroup?.id !== runGroup.id) {
        return
      }

      const [mapping, binding] = await Promise.all([
        tx
          .select({ orgId: githubRepoMappings.orgId })
          .from(githubRepoMappings)
          .where(
            and(
              eq(githubRepoMappings.installationId, snapshot.source.installationId),
              eq(githubRepoMappings.githubRepoId, snapshot.source.repositoryId),
            ),
          )
          .limit(1),
        runGroup.repoBindingId
          ? tx
              .select({ namespace: principalRepoBindings.canonicalRepoNamespace })
              .from(principalRepoBindings)
              .where(eq(principalRepoBindings.id, runGroup.repoBindingId))
              .limit(1)
          : Promise.resolve([]),
      ])
      const expectedNamespace = `${snapshot.source.owner}--${snapshot.source.repository}`
      if (mapping[0]?.orgId !== runGroup.orgId || binding[0]?.namespace !== expectedNamespace) {
        return
      }

      const [deployments, runs, activeJobs, historicalJobs] = await Promise.all([
        tx
          .select()
          .from(workspaceDeployments)
          .where(eq(workspaceDeployments.runGroupId, runGroup.id)),
        tx.select().from(tfRuns).where(eq(tfRuns.runGroupId, runGroup.id)),
        tx.select().from(iacJobs).where(eq(iacJobs.runGroupId, runGroup.id)),
        tx.select().from(iacJobHistory).where(eq(iacJobHistory.runGroupId, runGroup.id)),
      ])
      const jobs = [...activeJobs, ...historicalJobs]
      const workspaces = deployments
        .filter((deployment) =>
          isExecutionContextAssociationValid({
            snapshot,
            runGroup,
            resource: deployment,
            canonicalRepoNamespace: binding[0]?.namespace,
            requireRepoBinding: true,
          }),
        )
        .map((deployment) => {
          const deploymentRuns = runs
            .filter((run) => run.deploymentId === deployment.id)
            .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
          const previewPlan = deploymentRuns.find(
            (run) => run.runType === "plan" && run.planPurpose === "environment",
          )
          const mergePlan = deploymentRuns.find(
            (run) => run.runType === "plan" && run.planPurpose === "merge_impact",
          )
          const hasMergeJob = jobs.some(
            (job) => job.deploymentId === deployment.id && job.planPurpose === "merge_impact",
          )
          return {
            path: deployment.workspacePath,
            preview: {
              status: deployment.status,
              planSummary: previewPlan?.planSummary ?? null,
            },
            mergeImpact:
              snapshot.mergeImpact && (hasMergeJob || mergePlan)
                ? {
                    status: mergePlan?.status ?? "pending",
                    planSummary: mergePlan?.planSummary ?? null,
                  }
                : null,
          }
        })

      const appUrl = getEnv().betterAuthUrl.replace(/\/$/, "")
      const detailsUrl = `${appUrl}/app/${snapshot.source.owner}/${snapshot.source.repository}/env/${snapshot.environment.name}?runGroupId=${runGroup.id}`
      await upsertPrComment(
        snapshot.source.installationId,
        snapshot.source.owner,
        snapshot.source.repository,
        prNumber,
        renderRunGroupComment({
          headSha: snapshot.source.commitSha,
          targetEnvironment: snapshot.mergeImpact?.environmentName ?? null,
          detailsUrl,
          workspaces,
        }),
        PR_COMMENT_MARKER,
      )
    })
  } catch (error) {
    logger.warn("failed to sync PR comment", {
      runGroupId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
