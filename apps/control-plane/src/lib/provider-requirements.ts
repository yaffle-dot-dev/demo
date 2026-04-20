import { readdir, readFile, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { cleanupWorkspace } from "./workspace.ts"
import { createWorkspaceCache } from "./workspace-cache.ts"
import { scopeListAllows } from "./connection-scope.ts"
import type { Connection } from "../db/queries/connections.ts"
import {
  findRunGroupById,
  findRunGroupsByIds,
  type RunGroup,
} from "../db/queries/run-groups.ts"
import {
  getConnectionRequirementsDurationHistogram,
  getConnectionRequirementsDeploymentsScannedHistogram,
  getConnectionRequirementsProvidersScannedHistogram,
  getConnectionRequirementsProviderCacheCounter,
  withSpan,
} from "./telemetry.ts"

export interface ProviderRequirementDeployment {
  orgId: string
  repo: string
  environmentName: string
  workspacePath: string
  runGroupId: string | null
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

const workspaceProviderCache = new Map<string, string[]>()

const PROVIDER_CACHE_MAX_ENTRIES = 500
const PROVIDER_CACHE_TTL_MS = 10 * 60 * 1000
const DEFAULT_EXTRACTION_CONCURRENCY = 4

interface WorkspaceProviderCacheEntry {
  providers: string[]
  expiresAt: number
}

const workspaceProviderCacheV2 = new Map<string, WorkspaceProviderCacheEntry>()

function getCachedWorkspaceProviders(key: string): string[] | null {
  const cached = workspaceProviderCacheV2.get(key)
  if (!cached) {
    getConnectionRequirementsProviderCacheCounter().add(1, { result: "miss" })
    return null
  }

  if (cached.expiresAt <= Date.now()) {
    workspaceProviderCacheV2.delete(key)
    getConnectionRequirementsProviderCacheCounter().add(1, { result: "expired" })
    return null
  }

  workspaceProviderCacheV2.delete(key)
  workspaceProviderCacheV2.set(key, cached)
  getConnectionRequirementsProviderCacheCounter().add(1, { result: "hit" })
  return cached.providers
}

function setCachedWorkspaceProviders(key: string, providers: string[]): void {
  if (workspaceProviderCacheV2.size >= PROVIDER_CACHE_MAX_ENTRIES) {
    const oldestKey = workspaceProviderCacheV2.keys().next().value
    if (oldestKey) {
      workspaceProviderCacheV2.delete(oldestKey)
      getConnectionRequirementsProviderCacheCounter().add(1, { result: "evict" })
    }
  }

  workspaceProviderCacheV2.set(key, {
    providers,
    expiresAt: Date.now() + PROVIDER_CACHE_TTL_MS,
  })
}

function workspaceExtractionKey(workspaceS3Key: string, workspacePath: string): string {
  return `${workspaceS3Key}:${workspacePath}`
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
      files.push(...await findTerraformFiles(fullPath))
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
  providers: Set<string>,
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
      providers.add(providerMatch[1])
    }

    REQUIRED_PROVIDER_PATTERN.lastIndex = 0
    let requiredMatch: RegExpExecArray | null
    while ((requiredMatch = REQUIRED_PROVIDER_PATTERN.exec(content)) !== null) {
      const localName = requiredMatch[1]
      const source = requiredMatch[2]
      const sourceName = source.split("/").pop() ?? localName
      providers.add(sourceName)
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
          await extractProvidersFromDir(modulePath, providers, visitedDirs)
        }
      } catch {
        continue
      }
    }
  }
}

async function extractProviders(workspaceDir: string): Promise<string[]> {
  const providers = new Set<string>()
  const visitedDirs = new Set<string>()
  await extractProvidersFromDir(workspaceDir, providers, visitedDirs)
  return [...providers].filter((provider) => !NO_CREDENTIAL_PROVIDERS.has(provider)).sort()
}

export function connectionMatches(
  connection: Connection,
  provider: string,
  environment: string,
  workspace: string,
): boolean {
  const config = typeof connection.config === "object" && connection.config !== null
    ? connection.config as Record<string, unknown>
    : {}

  const providerType = typeof config.providerType === "string" ? config.providerType : connection.type
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
    runGroup?: Pick<RunGroup, "id" | "workspaceS3Key"> | null
  },
): Promise<string[]> {
  if (!deployment.runGroupId) {
    return []
  }

  const runGroup = opts?.runGroup ?? await findRunGroupById(deployment.runGroupId)
  if (!runGroup?.workspaceS3Key) {
    return []
  }
  const workspaceS3Key = runGroup.workspaceS3Key

  const cacheKey = workspaceExtractionKey(workspaceS3Key, deployment.workspacePath)
  const cached = getCachedWorkspaceProviders(cacheKey)
  if (cached) {
    return cached
  }

  return withSpan("connections.extract_workspace_providers", async (span) => {
    span.setAttributes({
      "connections.workspace_s3_key": workspaceS3Key,
      "connections.workspace_path": deployment.workspacePath,
    })

    const workspaceCache = createWorkspaceCache()
    const repoDir = await workspaceCache.extractWorkspaceToTemp(workspaceS3Key)

    try {
      const workspaceDir = join(repoDir, deployment.workspacePath)
      const providers = await extractProviders(workspaceDir)
      setCachedWorkspaceProviders(cacheKey, providers)
      return providers
    } finally {
      await cleanupWorkspace(repoDir)
    }
  })
}

export async function getRequiredProvidersForDeployments(
  deployments: ProviderRequirementDeployment[],
  opts?: {
    extractionConcurrency?: number
    runGroupsById?: Map<string, Pick<RunGroup, "id" | "workspaceS3Key">>
  },
): Promise<Map<string, string[]>> {
  if (deployments.length === 0) {
    return new Map()
  }

  const extractionConcurrency = Math.max(1, opts?.extractionConcurrency ?? DEFAULT_EXTRACTION_CONCURRENCY)
  const runGroupIds = [...new Set(
    deployments
      .map((deployment) => deployment.runGroupId)
      .filter((runGroupId): runGroupId is string => typeof runGroupId === "string"),
  )]

  const runGroupsById = opts?.runGroupsById ?? await findRunGroupsByIds(runGroupIds)
  const providersByDeployment = new Map<string, string[]>()
  const missingByArchive = new Map<string, Array<{
    deploymentKey: string
    workspaceCacheKey: string
    workspacePath: string
  }>>()

  for (const deployment of deployments) {
    const deploymentKey = providerDeploymentKey(deployment)

    if (!deployment.runGroupId) {
      providersByDeployment.set(deploymentKey, [])
      continue
    }

    const runGroup = runGroupsById.get(deployment.runGroupId)
    if (!runGroup?.workspaceS3Key) {
      providersByDeployment.set(deploymentKey, [])
      continue
    }

    const workspaceCacheKey = workspaceExtractionKey(runGroup.workspaceS3Key, deployment.workspacePath)
    const cached = getCachedWorkspaceProviders(workspaceCacheKey)
    if (cached) {
      providersByDeployment.set(deploymentKey, cached)
      continue
    }

    const existing = missingByArchive.get(runGroup.workspaceS3Key)
    if (existing) {
      existing.push({
        deploymentKey,
        workspaceCacheKey,
        workspacePath: deployment.workspacePath,
      })
    } else {
      missingByArchive.set(runGroup.workspaceS3Key, [{
        deploymentKey,
        workspaceCacheKey,
        workspacePath: deployment.workspacePath,
      }])
    }
  }

  const workspaceCache = createWorkspaceCache()
  const archiveEntries = [...missingByArchive.entries()]

  await mapWithConcurrency(archiveEntries, extractionConcurrency, async ([workspaceS3Key, workspaces]) => {
    await withSpan("connections.extract_workspace_providers_batch", async (span) => {
      span.setAttributes({
        "connections.workspace_s3_key": workspaceS3Key,
        "connections.workspace_count": workspaces.length,
      })

      const repoDir = await workspaceCache.extractWorkspaceToTemp(workspaceS3Key)

      try {
        await Promise.all(workspaces.map(async (workspace) => {
          let providers: string[] = []

          try {
            providers = await extractProviders(join(repoDir, workspace.workspacePath))
          } catch {
            providers = []
          }

          setCachedWorkspaceProviders(workspace.workspaceCacheKey, providers)
          providersByDeployment.set(workspace.deploymentKey, providers)
        }))
      } finally {
        await cleanupWorkspace(repoDir)
      }
    })
  })

  return providersByDeployment
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return []
  }

  const results = new Array<R>(items.length)
  let index = 0

  const runWorker = async (): Promise<void> => {
    while (index < items.length) {
      const current = index
      index += 1
      results[current] = await worker(items[current])
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runWorker(),
  )

  await Promise.all(workers)
  return results
}

export interface FindMissingConnectionRequirementsOptions {
  extractionConcurrency?: number
  getProvidersForDeployment?: (deployment: ProviderRequirementDeployment) => Promise<string[]>
}

export async function findMissingConnectionRequirements(params: {
  deployments: ProviderRequirementDeployment[]
  connections: Connection[]
}, opts: FindMissingConnectionRequirementsOptions = {}): Promise<MissingConnectionRequirement[]> {
  const startedAt = performance.now()
  const deploymentsScanned = params.deployments.length

  getConnectionRequirementsDeploymentsScannedHistogram().record(deploymentsScanned)

  const extractionConcurrency = Math.max(1, opts.extractionConcurrency ?? DEFAULT_EXTRACTION_CONCURRENCY)

  const result = await withSpan("connections.find_missing_requirements", async (span) => {
    span.setAttributes({
      "connections.deployments_scanned": deploymentsScanned,
      "connections.connections_count": params.connections.length,
      "connections.extraction_concurrency": extractionConcurrency,
    })

    const runGroupIds = [...new Set(
      params.deployments
        .map((deployment) => deployment.runGroupId)
        .filter((runGroupId): runGroupId is string => typeof runGroupId === "string"),
    )]

    const runGroupsById = opts.getProvidersForDeployment
      ? new Map<string, RunGroup>()
      : await findRunGroupsByIds(runGroupIds)

    const deploymentsByExtractionKey = new Map<string, ProviderRequirementDeployment[]>()

    for (const deployment of params.deployments) {
      if (!deployment.runGroupId) {
        continue
      }

      const key = opts.getProvidersForDeployment
        ? `${deployment.runGroupId}:${deployment.workspacePath}`
        : (() => {
          const runGroup = runGroupsById.get(deployment.runGroupId)
          if (!runGroup?.workspaceS3Key) {
            return null
          }
          return workspaceExtractionKey(runGroup.workspaceS3Key, deployment.workspacePath)
        })()

      if (!key) {
        continue
      }

      const current = deploymentsByExtractionKey.get(key)
      if (current) {
        current.push(deployment)
      } else {
        deploymentsByExtractionKey.set(key, [deployment])
      }
    }

    const providersByExtractionKey = new Map<string, string[]>()
    const extractionEntries = [...deploymentsByExtractionKey.entries()]

    await mapWithConcurrency(extractionEntries, extractionConcurrency, async ([key, deployments]) => {
      const deployment = deployments[0]

      let providers: string[] = []
      try {
        providers = opts.getProvidersForDeployment
          ? await opts.getProvidersForDeployment(deployment)
          : await getRequiredProvidersForDeployment(deployment, {
            runGroup: runGroupsById.get(deployment.runGroupId ?? "") ?? null,
          })
      } catch {
        providers = []
      }

      providersByExtractionKey.set(key, providers)
    })

    let providersScanned = 0
    const missing: MissingConnectionRequirement[] = []

    for (const deployment of params.deployments) {
      if (!deployment.runGroupId) {
        continue
      }

      const key = opts.getProvidersForDeployment
        ? `${deployment.runGroupId}:${deployment.workspacePath}`
        : (() => {
          const runGroup = runGroupsById.get(deployment.runGroupId)
          if (!runGroup?.workspaceS3Key) {
            return null
          }
          return workspaceExtractionKey(runGroup.workspaceS3Key, deployment.workspacePath)
        })()

      if (!key) {
        continue
      }

      const providers = providersByExtractionKey.get(key) ?? []
      providersScanned += providers.length

      for (const provider of providers) {
        const hasMatch = params.connections.some((connection) =>
          connectionMatches(connection, provider, deployment.environmentName, deployment.workspacePath)
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
      "connections.extractions_total": extractionEntries.length,
    })

    return missing.sort((a, b) =>
      a.repo.localeCompare(b.repo)
      || a.environment.localeCompare(b.environment)
      || a.workspace.localeCompare(b.workspace)
      || a.provider.localeCompare(b.provider)
    )
  })

  getConnectionRequirementsDurationHistogram().record(performance.now() - startedAt)
  return result
}

export function clearWorkspaceProviderCacheForTests(): void {
  workspaceProviderCache.clear()
  workspaceProviderCacheV2.clear()
}
