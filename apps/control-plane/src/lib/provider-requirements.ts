import { readdir, readFile, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { scopeListAllows } from "./connection-scope.ts"
import type { Connection } from "../db/queries/connections.ts"
import {
  buildRunGroupWorkspaceMetadataKey,
  findRunGroupWorkspaceMetadata,
  findRunGroupWorkspaceMetadataForRunGroups,
  type RunGroupWorkspaceMetadata,
} from "../db/queries/run-group-workspace-metadata.ts"
import {
  getConnectionRequirementsDurationHistogram,
  getConnectionRequirementsDeploymentsScannedHistogram,
  getConnectionRequirementsProvidersScannedHistogram,
  withSpan,
} from "./telemetry.ts"
import { logger } from "./telemetry.ts"

export interface ProviderRequirementDeployment {
  orgId: string
  repo: string
  environmentName: string
  workspacePath: string
  runGroupId: string | null
}

export interface ExtractedProviderRequirement {
  providerType: string
  providerSource: string | null
}

export type WorkspaceMetadataErrorKind =
  | "workspace_cache_missing"
  | "access_denied"
  | "metadata_missing"
  | "metadata_pending"
  | "unknown"

export interface ProviderRequirementsDegradation {
  kind: "provider_requirements_unavailable"
  errorKind: WorkspaceMetadataErrorKind
  message: string
  retryable: boolean
}

export class WorkspaceMetadataUnavailableError extends Error {
  readonly degradation: ProviderRequirementsDegradation

  constructor(degradation: ProviderRequirementsDegradation) {
    super(degradation.message)
    this.name = "WorkspaceMetadataUnavailableError"
    this.degradation = degradation
  }
}

function providerDeploymentKey(deployment: ProviderRequirementDeployment): string {
  return `${deployment.runGroupId ?? "no-run-group"}:${deployment.workspacePath}`
}

const PROVIDER_BLOCK_PATTERN = /provider\s+"([^"]+)"/g
const REQUIRED_PROVIDER_PATTERN = /(\w+)\s*=\s*\{[^}]*source\s*=\s*"([^"]+)"/gms
const MODULE_SOURCE_PATTERN = /source\s*=\s*"([^"]+)"/g

const NO_CREDENTIAL_PROVIDERS = new Set([
  "null",
  "random",
  "local",
  "tls",
  "time",
  "archive",
  "http",
  "external",
  "terraform",
])

export interface MissingConnectionRequirement {
  repo: string
  environment: string
  workspace: string
  provider: string
  recommended: string
}

const DEFAULT_EXTRACTION_CONCURRENCY = 4

function normalizeRequirementKey(providerType: string): string {
  return providerType.trim().toLowerCase()
}

function normalizeProviderRequirements(
  requirements: Iterable<ExtractedProviderRequirement>,
): ExtractedProviderRequirement[] {
  const deduped = new Map<string, ExtractedProviderRequirement>()

  for (const requirement of requirements) {
    const providerType = requirement.providerType.trim().toLowerCase()
    if (!providerType || NO_CREDENTIAL_PROVIDERS.has(providerType)) {
      continue
    }

    const providerSource = requirement.providerSource?.trim().toLowerCase() ?? null
    const existing = deduped.get(providerType)
    if (!existing) {
      deduped.set(providerType, {
        providerType,
        providerSource,
      })
      continue
    }

    if (!existing.providerSource && providerSource) {
      deduped.set(providerType, {
        providerType,
        providerSource,
      })
    }
  }

  return [...deduped.values()].sort((a, b) => a.providerType.localeCompare(b.providerType))
}

export function classifyWorkspaceExtractionError(error: unknown): WorkspaceMetadataErrorKind {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes("The specified key does not exist") || message.includes("NoSuchKey")) {
    return "workspace_cache_missing"
  }
  if (message.includes("AccessDenied") || message.includes("Unauthorized")) {
    return "access_denied"
  }
  return "unknown"
}

export function buildProviderRequirementsDegradation(
  error: unknown,
): ProviderRequirementsDegradation {
  if (error instanceof WorkspaceMetadataUnavailableError) {
    return error.degradation
  }

  const errorKind = classifyWorkspaceExtractionError(error)

  switch (errorKind) {
    case "workspace_cache_missing":
      return {
        kind: "provider_requirements_unavailable",
        errorKind,
        message:
          "Cached workspace archive is missing. Rerun this environment to regenerate provider metadata.",
        retryable: false,
      }
    case "access_denied":
      return {
        kind: "provider_requirements_unavailable",
        errorKind,
        message:
          "Yaffle could not inspect this workspace because access to the cached workspace archive was denied.",
        retryable: false,
      }
    default:
      return {
        kind: "provider_requirements_unavailable",
        errorKind,
        message: "Yaffle could not inspect this workspace to determine required providers.",
        retryable: true,
      }
  }
}

function buildStoredMetadataDegradation(
  metadata: Pick<RunGroupWorkspaceMetadata, "errorKind" | "errorMessage" | "retryable">,
): ProviderRequirementsDegradation {
  const errorKind = (metadata.errorKind ?? "unknown") as WorkspaceMetadataErrorKind

  if (metadata.errorMessage) {
    return {
      kind: "provider_requirements_unavailable",
      errorKind,
      message: metadata.errorMessage,
      retryable: metadata.retryable,
    }
  }

  switch (errorKind) {
    case "workspace_cache_missing":
      return {
        kind: "provider_requirements_unavailable",
        errorKind,
        message:
          "Cached workspace archive is missing. Rerun this environment to regenerate provider metadata.",
        retryable: false,
      }
    case "access_denied":
      return {
        kind: "provider_requirements_unavailable",
        errorKind,
        message:
          "Yaffle could not inspect this workspace because access to provider metadata was denied.",
        retryable: false,
      }
    case "metadata_missing":
      return {
        kind: "provider_requirements_unavailable",
        errorKind,
        message:
          "Provider metadata is missing for this workspace. Rerun this environment to regenerate it.",
        retryable: false,
      }
    case "metadata_pending":
      return {
        kind: "provider_requirements_unavailable",
        errorKind,
        message: "Provider metadata is still being prepared for this workspace.",
        retryable: true,
      }
    default:
      return {
        kind: "provider_requirements_unavailable",
        errorKind,
        message: "Yaffle could not inspect this workspace to determine required providers.",
        retryable: true,
      }
  }
}

function metadataRowToRequirements(
  metadata: Pick<RunGroupWorkspaceMetadata, "providerRequirements">,
): ExtractedProviderRequirement[] {
  const raw = Array.isArray(metadata.providerRequirements) ? metadata.providerRequirements : []

  return normalizeProviderRequirements(
    raw.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return []
      }

      const requirement = entry as Record<string, unknown>
      return [
        {
          providerType:
            typeof requirement.providerType === "string" ? requirement.providerType : "",
          providerSource:
            typeof requirement.providerSource === "string" ? requirement.providerSource : null,
        } satisfies ExtractedProviderRequirement,
      ]
    }),
  )
}

async function findTerraformFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue
    }

    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await findTerraformFiles(fullPath)))
    } else if (entry.isFile() && entry.name.endsWith(".tf")) {
      files.push(fullPath)
    }
  }

  return files
}

function isLocalModuleSource(source: string): boolean {
  if (source.startsWith("./") || source.startsWith("../") || source.startsWith("/")) {
    return true
  }

  if (source.startsWith("git::") || source.includes("://")) {
    return false
  }

  return false
}

async function extractProvidersFromDir(
  rootDir: string,
  requirements: Map<string, ExtractedProviderRequirement>,
  visitedDirs: Set<string>,
): Promise<void> {
  const resolvedRoot = resolve(rootDir)
  if (visitedDirs.has(resolvedRoot)) {
    return
  }
  visitedDirs.add(resolvedRoot)

  const tfFiles = await findTerraformFiles(resolvedRoot)

  for (const tfFile of tfFiles) {
    const content = await readFile(tfFile, "utf8")

    PROVIDER_BLOCK_PATTERN.lastIndex = 0
    let providerMatch: RegExpExecArray | null
    while ((providerMatch = PROVIDER_BLOCK_PATTERN.exec(content)) !== null) {
      const providerType = providerMatch[1].trim().toLowerCase()
      if (!providerType) {
        continue
      }

      const key = normalizeRequirementKey(providerType)
      const existing = requirements.get(key)
      requirements.set(key, {
        providerType,
        providerSource: existing?.providerSource ?? null,
      })
    }

    REQUIRED_PROVIDER_PATTERN.lastIndex = 0
    let requiredMatch: RegExpExecArray | null
    while ((requiredMatch = REQUIRED_PROVIDER_PATTERN.exec(content)) !== null) {
      const localName = requiredMatch[1]
      const source = requiredMatch[2].trim().toLowerCase()
      const sourceName = source.split("/").pop() ?? localName
      const providerType = sourceName.trim().toLowerCase()
      if (!providerType) {
        continue
      }

      requirements.set(normalizeRequirementKey(providerType), {
        providerType,
        providerSource: source,
      })
    }

    MODULE_SOURCE_PATTERN.lastIndex = 0
    let sourceMatch: RegExpExecArray | null
    while ((sourceMatch = MODULE_SOURCE_PATTERN.exec(content)) !== null) {
      const source = sourceMatch[1]
      if (!isLocalModuleSource(source)) {
        continue
      }

      const modulePath = resolve(dirname(tfFile), source)
      try {
        const stats = await stat(modulePath)
        if (stats.isDirectory()) {
          await extractProvidersFromDir(modulePath, requirements, visitedDirs)
        }
      } catch {
        continue
      }
    }
  }
}

export async function extractProviderRequirementsFromWorkspaceDir(
  workspaceDir: string,
): Promise<ExtractedProviderRequirement[]> {
  const requirements = new Map<string, ExtractedProviderRequirement>()
  const visitedDirs = new Set<string>()
  await extractProvidersFromDir(workspaceDir, requirements, visitedDirs)
  return normalizeProviderRequirements(requirements.values())
}

export function connectionMatches(
  connection: Connection,
  provider: string,
  environment: string,
  workspace: string,
): boolean {
  const config =
    typeof connection.config === "object" && connection.config !== null
      ? (connection.config as Record<string, unknown>)
      : {}

  const providerType =
    typeof config.providerType === "string" ? config.providerType : connection.type
  if (providerType.toLowerCase() !== provider.toLowerCase()) {
    return false
  }

  const environments = Array.isArray(config.environmentScope)
    ? config.environmentScope.filter((value): value is string => typeof value === "string")
    : []
  const workspaces = Array.isArray(config.workspaceScope)
    ? config.workspaceScope.filter((value): value is string => typeof value === "string")
    : []

  const environmentAllowed = scopeListAllows(environments, environment)
  const workspaceAllowed = scopeListAllows(workspaces, workspace)

  return environmentAllowed && workspaceAllowed
}

function recommendedProviderType(provider: string): string {
  return provider.toLowerCase() === "aws" ? "AWS IAM Role" : "Environment Variables"
}

export async function getRequiredProvidersForDeployment(
  deployment: ProviderRequirementDeployment,
  opts?: {
    metadata?: RunGroupWorkspaceMetadata | null
  },
): Promise<string[]> {
  const requirements = await getRequiredProviderRequirementsForDeployment(deployment, opts)
  return requirements.map((requirement) => requirement.providerType)
}

export async function getRequiredProviderRequirementsForDeployment(
  deployment: ProviderRequirementDeployment,
  opts?: {
    metadata?: RunGroupWorkspaceMetadata | null
  },
): Promise<ExtractedProviderRequirement[]> {
  if (!deployment.runGroupId) {
    return []
  }

  const metadata =
    opts?.metadata ??
    (await findRunGroupWorkspaceMetadata(deployment.runGroupId, deployment.workspacePath))

  if (!metadata) {
    logger.warn("connection_readiness.degraded", {
      orgId: deployment.orgId,
      repo: deployment.repo,
      environment: deployment.environmentName,
      workspacePath: deployment.workspacePath,
      runGroupId: deployment.runGroupId,
      degradationKind: "provider_requirements_unavailable",
      errorKind: "metadata_missing",
      retryable: false,
    })

    throw new WorkspaceMetadataUnavailableError({
      kind: "provider_requirements_unavailable",
      errorKind: "metadata_missing",
      message:
        "Provider metadata is missing for this workspace. Rerun this environment to regenerate it.",
      retryable: false,
    })
  }

  if (metadata.extractionStatus === "failed") {
    throw new WorkspaceMetadataUnavailableError(buildStoredMetadataDegradation(metadata))
  }

  if (metadata.extractionStatus !== "ready") {
    throw new WorkspaceMetadataUnavailableError({
      kind: "provider_requirements_unavailable",
      errorKind: "metadata_pending",
      message: "Provider metadata is still being prepared for this workspace.",
      retryable: true,
    })
  }

  return metadataRowToRequirements(metadata)
}

export async function getRequiredProvidersForDeployments(
  deployments: ProviderRequirementDeployment[],
  opts?: {
    extractionConcurrency?: number
    metadataByRunGroupWorkspaceKey?: Map<string, RunGroupWorkspaceMetadata>
  },
): Promise<Map<string, string[]>> {
  if (deployments.length === 0) {
    return new Map()
  }

  const runGroupIds = [
    ...new Set(
      deployments
        .map((deployment) => deployment.runGroupId)
        .filter((runGroupId): runGroupId is string => typeof runGroupId === "string"),
    ),
  ]

  const metadataByRunGroupWorkspaceKey =
    opts?.metadataByRunGroupWorkspaceKey ??
    (await findRunGroupWorkspaceMetadataForRunGroups(runGroupIds))
  const providersByDeployment = new Map<string, string[]>()

  for (const deployment of deployments) {
    const deploymentKey = providerDeploymentKey(deployment)

    if (!deployment.runGroupId) {
      providersByDeployment.set(deploymentKey, [])
      continue
    }

    const metadata = metadataByRunGroupWorkspaceKey.get(
      buildRunGroupWorkspaceMetadataKey(deployment.runGroupId, deployment.workspacePath),
    )
    if (!metadata || metadata.extractionStatus !== "ready") {
      providersByDeployment.set(deploymentKey, [])
      continue
    }

    providersByDeployment.set(
      deploymentKey,
      metadataRowToRequirements(metadata).map((requirement) => requirement.providerType),
    )
  }

  return providersByDeployment
}

export interface FindMissingConnectionRequirementsOptions {
  extractionConcurrency?: number
  getProvidersForDeployment?: (deployment: ProviderRequirementDeployment) => Promise<string[]>
}

export async function findMissingConnectionRequirements(
  params: {
    deployments: ProviderRequirementDeployment[]
    connections: Connection[]
  },
  opts: FindMissingConnectionRequirementsOptions = {},
): Promise<MissingConnectionRequirement[]> {
  const startedAt = performance.now()
  const deploymentsScanned = params.deployments.length

  getConnectionRequirementsDeploymentsScannedHistogram().record(deploymentsScanned)

  const extractionConcurrency = Math.max(
    1,
    opts.extractionConcurrency ?? DEFAULT_EXTRACTION_CONCURRENCY,
  )

  const result = await withSpan("connections.find_missing_requirements", async (span) => {
    span.setAttributes({
      "connections.deployments_scanned": deploymentsScanned,
      "connections.connections_count": params.connections.length,
      "connections.extraction_concurrency": extractionConcurrency,
    })

    const runGroupIds = [
      ...new Set(
        params.deployments
          .map((deployment) => deployment.runGroupId)
          .filter((runGroupId): runGroupId is string => typeof runGroupId === "string"),
      ),
    ]

    const metadataByRunGroupWorkspaceKey = opts.getProvidersForDeployment
      ? new Map<string, RunGroupWorkspaceMetadata>()
      : await findRunGroupWorkspaceMetadataForRunGroups(runGroupIds)
    const providersByRunGroupWorkspaceKey = new Map<string, string[]>()

    let providersScanned = 0
    const missing: MissingConnectionRequirement[] = []

    for (const deployment of params.deployments) {
      if (!deployment.runGroupId) {
        continue
      }

      const metadataKey = buildRunGroupWorkspaceMetadataKey(
        deployment.runGroupId,
        deployment.workspacePath,
      )
      let providers = providersByRunGroupWorkspaceKey.get(metadataKey)

      if (!providers) {
        providers = opts.getProvidersForDeployment
          ? await opts.getProvidersForDeployment(deployment)
          : (() => {
              const metadata = metadataByRunGroupWorkspaceKey.get(metadataKey)
              if (!metadata || metadata.extractionStatus !== "ready") {
                return []
              }

              return metadataRowToRequirements(metadata).map(
                (requirement) => requirement.providerType,
              )
            })()

        providersByRunGroupWorkspaceKey.set(metadataKey, providers)
      }

      providersScanned += providers.length

      for (const provider of providers) {
        const hasMatch = params.connections.some((connection) =>
          connectionMatches(
            connection,
            provider,
            deployment.environmentName,
            deployment.workspacePath,
          ),
        )

        if (!hasMatch) {
          missing.push({
            repo: deployment.repo,
            environment: deployment.environmentName,
            workspace: deployment.workspacePath,
            provider,
            recommended: recommendedProviderType(provider),
          })
        }
      }
    }

    getConnectionRequirementsProvidersScannedHistogram().record(providersScanned)
    span.setAttributes({
      "connections.providers_scanned": providersScanned,
      "connections.extractions_total": runGroupIds.length,
    })

    return missing.sort(
      (a, b) =>
        a.repo.localeCompare(b.repo) ||
        a.environment.localeCompare(b.environment) ||
        a.workspace.localeCompare(b.workspace) ||
        a.provider.localeCompare(b.provider),
    )
  })

  getConnectionRequirementsDurationHistogram().record(performance.now() - startedAt)
  return result
}

export function clearWorkspaceProviderCacheForTests(): void {
  // No-op. Provider requirements are now read durably from Postgres.
}
