import { z } from "zod"

import {
  createJob,
  findActiveProviderDiscoveryJob,
  findRecentCompletedProviderDiscoveryJob,
} from "../db/queries/jobs.ts"
import type { ExtractedProviderRequirement } from "./provider-requirements.ts"
import {
  findProviderCredentialSignatureByType,
  listActiveProviderCredentialSignatures,
  upsertDiscoveredProviderCredentialSignature,
} from "../db/queries/provider-credential-signatures.ts"
import { logger } from "./telemetry.ts"

export const PROVIDER_DISCOVERY_REQUEUE_COOLDOWN_MS = 30 * 60 * 1000

export const providerDiscoveryResultSchema = z.object({
  requestId: z.string().uuid(),
  status: z.enum(["succeeded", "failed", "inconclusive"]),
  providerType: z.string().min(1),
  displayName: z.string().min(1).optional(),
  suggestedCredentialProviderType: z.enum(["envvar", "iam_role"]).optional(),
  exactEnvVars: z.array(z.string()).default([]),
  prefixEnvVars: z.array(z.string()).default([]),
  confidence: z.enum(["high", "medium", "low"]),
  sources: z
    .array(
      z.object({
        url: z.string().url(),
        kind: z.string().min(1),
      }),
    )
    .default([]),
  reasoningSummary: z.string().optional(),
})

function normalizeProviderType(value: string): string {
  return value.trim().toLowerCase()
}

function normalizeEnvVarKeys(keys: string[]): string[] {
  return [
    ...new Set(keys.map((key) => key.trim().toUpperCase()).filter((key) => key.length > 0)),
  ].sort()
}

function normalizePrefixKeys(prefixes: string[]): string[] {
  return [
    ...new Set(
      prefixes.map((prefix) => prefix.trim().toUpperCase()).filter((prefix) => prefix.length > 0),
    ),
  ].sort()
}

interface QueueUnknownProviderDiscoveryDeps {
  createJob: typeof createJob
  findActiveProviderDiscoveryJob: typeof findActiveProviderDiscoveryJob
  findProviderCredentialSignatureByType: typeof findProviderCredentialSignatureByType
  findRecentCompletedProviderDiscoveryJob: typeof findRecentCompletedProviderDiscoveryJob
  listActiveProviderCredentialSignatures: typeof listActiveProviderCredentialSignatures
  now: () => Date
}

const defaultQueueUnknownProviderDiscoveryDeps: QueueUnknownProviderDiscoveryDeps = {
  createJob,
  findActiveProviderDiscoveryJob,
  findProviderCredentialSignatureByType,
  findRecentCompletedProviderDiscoveryJob,
  listActiveProviderCredentialSignatures,
  now: () => new Date(),
}

export async function queueUnknownProviderDiscovery(
  params: {
    orgId: string
    providers: ExtractedProviderRequirement[]
    repo?: string
    environment?: string
    workspacePath?: string
  },
  deps: QueueUnknownProviderDiscoveryDeps = defaultQueueUnknownProviderDiscoveryDeps,
): Promise<void> {
  if (process.env.YAFFLE_PROVIDER_DISCOVERY_ENABLED !== "true") {
    return
  }

  const activeSignatures = await deps.listActiveProviderCredentialSignatures()
  const activeProviderSet = new Set(
    activeSignatures.map((signature) => signature.providerType.toLowerCase()),
  )
  const recentSince = new Date(deps.now().getTime() - PROVIDER_DISCOVERY_REQUEUE_COOLDOWN_MS)

  for (const requirement of params.providers) {
    const providerType = normalizeProviderType(requirement.providerType)
    const providerSource = requirement.providerSource?.trim().toLowerCase() || undefined
    if (!providerType) {
      continue
    }

    if (activeProviderSet.has(providerType)) {
      continue
    }

    const existingSignature = await deps.findProviderCredentialSignatureByType(providerType)
    if (existingSignature) {
      continue
    }

    const activeJob = await deps.findActiveProviderDiscoveryJob(params.orgId, providerType)
    if (activeJob) {
      continue
    }

    const recentJob = await deps.findRecentCompletedProviderDiscoveryJob({
      orgId: params.orgId,
      providerType,
      providerSource,
      since: recentSince,
    })
    if (recentJob) {
      logger.info("provider_discovery.skipped_recent", {
        orgId: params.orgId,
        providerType,
        providerSource,
        repo: params.repo,
        environment: params.environment,
        workspacePath: params.workspacePath,
        recentJobId: recentJob.id,
        recentJobStatus: recentJob.status,
        recentJobCreatedAt: recentJob.createdAt.toISOString(),
        cooldownMs: PROVIDER_DISCOVERY_REQUEUE_COOLDOWN_MS,
      })
      continue
    }

    await deps.createJob({
      orgId: params.orgId,
      jobType: "provider_discovery",
      payload: {
        providerType,
        providerSource,
        repo: params.repo,
        environment: params.environment,
        workspacePath: params.workspacePath,
        requestedByOrgId: params.orgId,
      },
    })

    logger.info("provider_discovery.queued", {
      orgId: params.orgId,
      providerType,
      providerSource,
      repo: params.repo,
      environment: params.environment,
      workspacePath: params.workspacePath,
    })
  }
}

export async function applyProviderDiscoveryResult(
  result: z.infer<typeof providerDiscoveryResultSchema>,
): Promise<void> {
  if (result.status !== "succeeded") {
    logger.warn("provider_discovery.incomplete_result", {
      requestId: result.requestId,
      providerType: result.providerType,
      status: result.status,
      confidence: result.confidence,
      exactEnvVarCount: result.exactEnvVars.length,
      prefixEnvVarCount: result.prefixEnvVars.length,
      sourceCount: result.sources.length,
      reasoningSummary: result.reasoningSummary,
    })
    return
  }

  const providerType = normalizeProviderType(result.providerType)
  const displayName = result.displayName?.trim() || providerType
  const exactEnvVars = normalizeEnvVarKeys(result.exactEnvVars)
  const prefixEnvVars = normalizePrefixKeys(result.prefixEnvVars)
  const shouldAutoPromote = result.confidence === "high"

  await upsertDiscoveredProviderCredentialSignature({
    providerType,
    displayName,
    suggestedCredentialProviderType: result.suggestedCredentialProviderType ?? "envvar",
    exactEnvVars,
    prefixEnvVars,
    isActive: shouldAutoPromote,
    source: shouldAutoPromote ? "agent_auto" : "agent_candidate",
  })

  logger.info("provider_discovery.applied", {
    requestId: result.requestId,
    providerType,
    confidence: result.confidence,
    autoPromoted: shouldAutoPromote,
    sourceCount: result.sources.length,
    exactEnvVarCount: exactEnvVars.length,
    prefixEnvVarCount: prefixEnvVars.length,
  })
}
