import { join } from "node:path"

import type { RunGroup } from "../db/queries/run-groups.ts"

import {
  upsertRunGroupWorkspaceMetadata,
  type RunGroupWorkspaceMetadataInsert,
} from "../db/queries/run-group-workspace-metadata.ts"
import {
  buildProviderRequirementsDegradation,
  extractProviderRequirementsFromWorkspaceDir,
  type ProviderRequirementsDegradation,
} from "./provider-requirements.ts"
import { logger, withSpan } from "./telemetry.ts"
import { cleanupWorkspace } from "./workspace.ts"
import { createWorkspaceCache } from "./workspace-cache.ts"

type WorkspaceMetadataSource = "scan_job" | "backfill" | "repair"

function buildFailedMetadataRow(params: {
  runGroupId: string
  workspacePath: string
  degradation: ProviderRequirementsDegradation
  source: WorkspaceMetadataSource
  extractedAt: Date
}): RunGroupWorkspaceMetadataInsert {
  return {
    runGroupId: params.runGroupId,
    workspacePath: params.workspacePath,
    providerRequirements: [],
    extractionStatus: "failed",
    degradationKind: params.degradation.kind,
    errorKind: params.degradation.errorKind,
    errorMessage: params.degradation.message,
    retryable: params.degradation.retryable,
    source: params.source,
    extractedAt: params.extractedAt,
    updatedAt: params.extractedAt,
  }
}

function logWorkspaceMetadataDegradation(params: {
  runGroup: Pick<RunGroup, "id" | "orgId" | "repo" | "environmentName">
  workspacePath: string
  workspaceS3Key?: string | null
  degradation: ProviderRequirementsDegradation
}): void {
  logger.warn("connection_readiness.degraded", {
    orgId: params.runGroup.orgId,
    repo: params.runGroup.repo,
    environment: params.runGroup.environmentName,
    workspacePath: params.workspacePath,
    workspaceS3Key: params.workspaceS3Key ?? undefined,
    runGroupId: params.runGroup.id,
    degradationKind: params.degradation.kind,
    errorKind: params.degradation.errorKind,
    retryable: params.degradation.retryable,
    error: params.degradation.message,
  })
}

export async function persistRunGroupWorkspaceMetadataFromArchive(params: {
  runGroup: Pick<RunGroup, "id" | "orgId" | "repo" | "environmentName">
  workspacePaths: string[]
  workspaceS3Key?: string | null
  source: WorkspaceMetadataSource
}): Promise<void> {
  if (params.workspacePaths.length === 0) {
    return
  }

  await withSpan("connections.persist_workspace_metadata", async (span) => {
    span.setAttributes({
      "yaffle.org_id": params.runGroup.orgId,
      "yaffle.repo": params.runGroup.repo,
      "yaffle.environment": params.runGroup.environmentName,
      "connections.workspace_count": params.workspacePaths.length,
      "connections.workspace_s3_key": params.workspaceS3Key ?? "",
      "connections.metadata_source": params.source,
    })

    const extractedAt = new Date()

    if (!params.workspaceS3Key) {
      const degradation = buildProviderRequirementsDegradation(new Error("The specified key does not exist."))
      const rows = params.workspacePaths.map((workspacePath) => {
        logWorkspaceMetadataDegradation({
          runGroup: params.runGroup,
          workspacePath,
          workspaceS3Key: params.workspaceS3Key,
          degradation,
        })

        return buildFailedMetadataRow({
          runGroupId: params.runGroup.id,
          workspacePath,
          degradation,
          source: params.source,
          extractedAt,
        })
      })

      await upsertRunGroupWorkspaceMetadata(rows)
      return
    }

    const workspaceCache = createWorkspaceCache()
    let repoDir: string | null = null

    try {
      repoDir = await workspaceCache.extractWorkspaceToTemp(params.workspaceS3Key)
    } catch (error) {
      const degradation = buildProviderRequirementsDegradation(error)
      const rows = params.workspacePaths.map((workspacePath) => {
        logWorkspaceMetadataDegradation({
          runGroup: params.runGroup,
          workspacePath,
          workspaceS3Key: params.workspaceS3Key,
          degradation,
        })

        return buildFailedMetadataRow({
          runGroupId: params.runGroup.id,
          workspacePath,
          degradation,
          source: params.source,
          extractedAt,
        })
      })

      await upsertRunGroupWorkspaceMetadata(rows)
      return
    }

    try {
      const rows: RunGroupWorkspaceMetadataInsert[] = []

      for (const workspacePath of params.workspacePaths) {
        try {
          const providerRequirements = await extractProviderRequirementsFromWorkspaceDir(
            join(repoDir, workspacePath),
          )

          rows.push({
            runGroupId: params.runGroup.id,
            workspacePath,
            providerRequirements,
            extractionStatus: "ready",
            degradationKind: null,
            errorKind: null,
            errorMessage: null,
            retryable: false,
            source: params.source,
            extractedAt,
            updatedAt: extractedAt,
          })
        } catch (error) {
          const degradation = buildProviderRequirementsDegradation(error)
          logWorkspaceMetadataDegradation({
            runGroup: params.runGroup,
            workspacePath,
            workspaceS3Key: params.workspaceS3Key,
            degradation,
          })

          rows.push(buildFailedMetadataRow({
            runGroupId: params.runGroup.id,
            workspacePath,
            degradation,
            source: params.source,
            extractedAt,
          }))
        }
      }

      await upsertRunGroupWorkspaceMetadata(rows)
    } finally {
      await cleanupWorkspace(repoDir)
    }
  })
}
