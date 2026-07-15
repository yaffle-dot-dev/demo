import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join, resolve, sep } from "node:path"

import * as hcl from "hcl2-parser"

import {
  computeAutomaticIsolationArtifactHash,
  deriveAutomaticIsolationWorkspaceStatus,
  inspectAutomaticPreviewIsolationWorkspace,
  type AutomaticIsolationArtifactManifest,
  type AutomaticIsolationIdentity,
  type AutomaticIsolationProviderLock,
  type AutomaticIsolationSourceFile,
  type AutomaticIsolationTransformation,
  type AutomaticIsolationWorkspacePreflight,
} from "@yaffle/shared"

const MANIFEST_PATH = ".yaffle/automatic-isolation-artifact.json"
const GENERATED_FILE_PATH = "yaffle_isolation_override.tf.json"
const STRATEGY_REVISION = "local-file-filename-v1"
const EMPTY_STRATEGY_REVISION = "no-managed-resources-v1"
const PROVIDER_SOURCE = "registry.opentofu.org/hashicorp/local"
const PROVIDER_VERSION = "2.5.3"
const RESOURCE_TYPE = "local_file"
const ATTRIBUTE = "filename"
const SEPARATOR = "-"
const MAX_LENGTH = 63
const SUFFIX_LENGTH = 10
const ALLOWED_PATTERN = "^[a-z0-9-]+$"
const BASE_LENGTH = MAX_LENGTH - SEPARATOR.length - SUFFIX_LENGTH

interface VerifiedSuffixAttributeStrategy {
  providerSource: string
  providerVersion: string
  resourceType: string
  attribute: string
  revision: string
}

function strategyKey(
  providerSource: string,
  providerVersion: string,
  resourceType: string,
): string {
  return `${providerSource}\0${providerVersion}\0${resourceType}`
}

const VERIFIED_SUFFIX_STRATEGIES = new Map<string, VerifiedSuffixAttributeStrategy>([
  [
    strategyKey(PROVIDER_SOURCE, PROVIDER_VERSION, RESOURCE_TYPE),
    {
      providerSource: PROVIDER_SOURCE,
      providerVersion: PROVIDER_VERSION,
      resourceType: RESOURCE_TYPE,
      attribute: ATTRIBUTE,
      revision: STRATEGY_REVISION,
    },
  ],
])

export interface CompiledAutomaticIsolationArtifact {
  manifest: AutomaticIsolationArtifactManifest
  files: Array<{ path: string; content: string }>
}

export interface CompileAutomaticIsolationArtifactInput {
  identity: AutomaticIsolationIdentity
  sourceRevision: string
  files: AutomaticIsolationSourceFile[]
}

export interface CompileAutomaticIsolationArtifactResult {
  preflight: AutomaticIsolationWorkspacePreflight
  artifact?: CompiledAutomaticIsolationArtifact
}

export class AutomaticIsolationArtifactError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "ARTIFACT_NOT_BOUND"
      | "MANIFEST_MISSING"
      | "MANIFEST_INVALID"
      | "MANIFEST_MISMATCH"
      | "GENERATED_FILE_INVALID"
      | "RESERVED_PATH_CONFLICT",
  ) {
    super(message)
    this.name = "AutomaticIsolationArtifactError"
  }
}

interface ParsedHclDocument {
  resource?: Record<string, Record<string, Array<Record<string, unknown>>>>
  terraform?: Array<{
    required_providers?: Array<Record<string, unknown>>
  }>
}

interface ParsedLockDocument {
  provider?: Record<string, Array<Record<string, unknown>>>
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function parseDocument(content: string): Record<string, unknown> | null {
  try {
    const parsed = hcl.parseToObject(content)
    const candidate = Array.isArray(parsed) ? parsed[0] : parsed
    return candidate && typeof candidate === "object"
      ? (candidate as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function readProviderLock(
  files: AutomaticIsolationSourceFile[],
): AutomaticIsolationProviderLock | null {
  const lockFile = files.find((file) => file.path.split("/").at(-1) === ".terraform.lock.hcl")
  if (!lockFile) {
    return null
  }

  const document = parseDocument(lockFile.content) as ParsedLockDocument | null
  const locked = document?.provider?.[PROVIDER_SOURCE]?.[0]
  if (!locked || locked.version !== PROVIDER_VERSION) {
    return null
  }

  return {
    source: PROVIDER_SOURCE,
    version: PROVIDER_VERSION,
    constraints: typeof locked.constraints === "string" ? locked.constraints : undefined,
    hashes: Array.isArray(locked.hashes)
      ? locked.hashes.filter((hash): hash is string => typeof hash === "string").sort()
      : [],
  }
}

function openTofuSourceStem(path: string): string | null {
  for (const extension of [".tofu.json", ".tf.json", ".tofu", ".tf"]) {
    if (path.endsWith(extension)) {
      return path.slice(0, -extension.length)
    }
  }
  return null
}

function isNativeOpenTofuSource(path: string): boolean {
  return path.endsWith(".tf") || path.endsWith(".tofu")
}

function normalizeProviderSource(source: string): string {
  return source.split("/").length === 2 ? `registry.opentofu.org/${source}` : source
}

function verifiedProviderNames(files: AutomaticIsolationSourceFile[]): Set<string> {
  const names = new Set<string>()
  for (const file of files.filter((candidate) => isNativeOpenTofuSource(candidate.path))) {
    const document = parseDocument(file.content) as ParsedHclDocument | null
    for (const terraformBlock of document?.terraform ?? []) {
      for (const requiredProviders of terraformBlock.required_providers ?? []) {
        for (const [name, provider] of Object.entries(requiredProviders)) {
          if (!provider || typeof provider !== "object") {
            continue
          }
          const source = (provider as Record<string, unknown>).source
          if (typeof source === "string" && normalizeProviderSource(source) === PROVIDER_SOURCE) {
            names.add(name)
          }
        }
      }
    }
  }
  return names
}

function workspaceRootFiles(
  workspacePath: string,
  files: AutomaticIsolationSourceFile[],
): AutomaticIsolationSourceFile[] {
  const prefix = workspacePath === "." ? "" : `${workspacePath}/`
  const rootFiles = files.flatMap((file) => {
    if (!file.path.startsWith(prefix)) {
      return []
    }
    const relativePath = file.path.slice(prefix.length)
    return relativePath.length > 0 && !relativePath.includes("/") ? [file] : []
  })
  const preferredNativeStems = new Set(
    rootFiles
      .filter((file) => file.path.endsWith(".tofu"))
      .map((file) => openTofuSourceStem(file.path)),
  )
  const preferredJsonStems = new Set(
    rootFiles
      .filter((file) => file.path.endsWith(".tofu.json"))
      .map((file) => openTofuSourceStem(file.path)),
  )
  return rootFiles.filter((file) => {
    if (file.path.endsWith(".tf.json")) {
      return !preferredJsonStems.has(openTofuSourceStem(file.path))
    }
    if (file.path.endsWith(".tf")) {
      return !preferredNativeStems.has(openTofuSourceStem(file.path))
    }
    return true
  })
}

function deriveSuffix(identity: AutomaticIsolationIdentity): string {
  return sha256(
    [
      identity.organizationId,
      identity.repositoryId,
      identity.workspacePath,
      identity.environmentKind,
      identity.environmentName,
    ].join("\0"),
  ).slice(0, SUFFIX_LENGTH)
}

function suffixExpression(expression: string, suffix: string): string | null {
  const directExpression = expression.match(/^\$\{(.+)\}$/s)
  if (directExpression?.[1]) {
    const source = directExpression[1]
    return `\${(${source}) == null ? null : format("%s${SEPARATOR}%s", substr(replace(lower((${source})), "/[^a-z0-9-]/", "-"), 0, ${BASE_LENGTH}), "${suffix}")}`
  }

  if (expression.includes("${") || !/^[A-Za-z0-9-]+$/.test(expression)) {
    return null
  }

  const normalized = expression
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  if (!normalized) {
    return null
  }

  return `${normalized.slice(0, BASE_LENGTH)}${SEPARATOR}${suffix}`
}

function compileTransformations(
  files: AutomaticIsolationSourceFile[],
  suffix: string,
  providerNames: Set<string>,
  strategy: VerifiedSuffixAttributeStrategy,
): Array<
  AutomaticIsolationTransformation & { transformedExpression: string; resourceName: string }
> {
  const transformations: Array<
    AutomaticIsolationTransformation & { transformedExpression: string; resourceName: string }
  > = []

  for (const file of files.filter((candidate) => isNativeOpenTofuSource(candidate.path))) {
    const document = parseDocument(file.content) as ParsedHclDocument | null
    const resources = document?.resource?.[strategy.resourceType] ?? {}
    for (const [resourceName, instances] of Object.entries(resources)) {
      const instance = instances[0]
      const providerReference = instance?.provider
      const providerName =
        typeof providerReference === "string"
          ? providerReference.replace(/^\$\{/, "").replace(/\}$/, "").split(".")[0]
          : strategy.resourceType.split("_")[0]
      if (!providerName || !providerNames.has(providerName)) {
        continue
      }
      const expression = instance?.[strategy.attribute]
      if (typeof expression !== "string") {
        continue
      }
      const transformedExpression = suffixExpression(expression, suffix)
      if (!transformedExpression) {
        continue
      }

      transformations.push({
        resourceAddress: `${strategy.resourceType}.${resourceName}`,
        resourceName,
        attribute: strategy.attribute,
        sourceFile: file.path,
        sourceExpression: expression,
        transformedExpression,
        strategyRevision: strategy.revision,
      })
    }
  }

  return transformations.sort((left, right) =>
    left.resourceAddress.localeCompare(right.resourceAddress),
  )
}

export function compileAutomaticIsolationArtifact(
  input: CompileAutomaticIsolationArtifactInput,
): CompileAutomaticIsolationArtifactResult {
  const files = workspaceRootFiles(input.identity.workspacePath, input.files)
  const inspected = inspectAutomaticPreviewIsolationWorkspace(input.identity.workspacePath, files)
  const providerLock = readProviderLock(files)
  const strategy = providerLock
    ? VERIFIED_SUFFIX_STRATEGIES.get(
        strategyKey(providerLock.source, providerLock.version, RESOURCE_TYPE),
      )
    : undefined
  const providerNames = providerLock ? verifiedProviderNames(files) : new Set<string>()
  const suffix = deriveSuffix(input.identity)
  const transformations =
    providerLock && strategy ? compileTransformations(files, suffix, providerNames, strategy) : []
  const transformedAddresses = new Set(
    transformations.map((transformation) => transformation.resourceAddress),
  )
  const findings = inspected.findings.filter(
    (finding) =>
      finding.code !== "resource_review_required" ||
      !finding.resourceAddress ||
      !transformedAddresses.has(finding.resourceAddress),
  )
  const preflight = {
    ...inspected,
    status: deriveAutomaticIsolationWorkspaceStatus(findings),
    findings,
  }

  if (preflight.status !== "ready") {
    return { preflight }
  }

  const hasTransformations = transformations.length > 0
  if (hasTransformations && !providerLock) {
    return { preflight: { ...preflight, status: "review_required" } }
  }

  const override = {
    resource: {
      [strategy?.resourceType ?? RESOURCE_TYPE]: Object.fromEntries(
        transformations.map((transformation) => [
          transformation.resourceName,
          {
            [strategy?.attribute ?? ATTRIBUTE]: transformation.transformedExpression,
          },
        ]),
      ),
    },
  }
  const generatedContent = `${JSON.stringify(override, null, 2)}\n`
  const generatedFiles = hasTransformations
    ? [{ path: GENERATED_FILE_PATH, content: generatedContent }]
    : []
  const manifestWithoutHash = {
    contractVersion: 1 as const,
    sourceRevision: input.sourceRevision,
    identity: input.identity,
    suffix,
    strategyRevision: hasTransformations
      ? (strategy?.revision ?? STRATEGY_REVISION)
      : EMPTY_STRATEGY_REVISION,
    naming: hasTransformations
      ? {
          separator: SEPARATOR,
          maxLength: MAX_LENGTH,
          allowedPattern: ALLOWED_PATTERN,
          collisionScope: "organization_repository_workspace_environment" as const,
        }
      : undefined,
    providerLocks: providerLock ? [providerLock] : [],
    transformations: transformations.map(
      ({ resourceName: _resourceName, transformedExpression: _transformedExpression, ...item }) =>
        item,
    ),
    files: generatedFiles.map((file) => ({ path: file.path, sha256: sha256(file.content) })),
  }
  const manifest: AutomaticIsolationArtifactManifest = {
    ...manifestWithoutHash,
    artifactHash: computeAutomaticIsolationArtifactHash(manifestWithoutHash),
  }

  return { preflight, artifact: { manifest, files: generatedFiles } }
}

export async function verifyAutomaticIsolationArtifact(
  workDir: string,
  required: boolean,
  expectedManifest?: AutomaticIsolationArtifactManifest,
): Promise<AutomaticIsolationArtifactManifest | undefined> {
  if (required && !expectedManifest) {
    throw new AutomaticIsolationArtifactError(
      "Automatic preview isolation artifact is not bound to execution context",
      "ARTIFACT_NOT_BOUND",
    )
  }

  let rawManifest: string
  try {
    rawManifest = await readFile(join(workDir, MANIFEST_PATH), "utf8")
  } catch (error) {
    if (!required && error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined
    }
    throw new AutomaticIsolationArtifactError(
      "Automatic preview isolation artifact is required but missing",
      "MANIFEST_MISSING",
    )
  }

  let manifest: AutomaticIsolationArtifactManifest
  try {
    manifest = JSON.parse(rawManifest) as AutomaticIsolationArtifactManifest
  } catch {
    throw new AutomaticIsolationArtifactError(
      "Automatic preview isolation artifact manifest is invalid",
      "MANIFEST_INVALID",
    )
  }
  const { artifactHash, ...manifestWithoutHash } = manifest
  if (computeAutomaticIsolationArtifactHash(manifestWithoutHash) !== artifactHash) {
    throw new AutomaticIsolationArtifactError(
      "Automatic preview isolation artifact manifest hash does not match",
      "MANIFEST_INVALID",
    )
  }
  if (expectedManifest && artifactHash !== expectedManifest.artifactHash) {
    throw new AutomaticIsolationArtifactError(
      "Automatic preview isolation artifact does not match execution context",
      "MANIFEST_MISMATCH",
    )
  }

  const workspaceRoot = `${resolve(workDir)}${sep}`
  for (const file of manifest.files) {
    const filePath = resolve(workDir, file.path)
    if (!filePath.startsWith(workspaceRoot)) {
      throw new AutomaticIsolationArtifactError(
        `Automatic preview isolation artifact path escapes workspace: ${file.path}`,
        "GENERATED_FILE_INVALID",
      )
    }
    let content: string
    try {
      content = await readFile(filePath, "utf8")
    } catch {
      throw new AutomaticIsolationArtifactError(
        `Automatic preview isolation artifact file is missing or unreadable: ${file.path}`,
        "GENERATED_FILE_INVALID",
      )
    }
    if (sha256(content) !== file.sha256) {
      throw new AutomaticIsolationArtifactError(
        `Automatic preview isolation artifact file hash does not match: ${file.path}`,
        "GENERATED_FILE_INVALID",
      )
    }
  }

  return manifest
}

export const automaticIsolationArtifactPaths = {
  manifest: MANIFEST_PATH,
  generated: GENERATED_FILE_PATH,
} as const
