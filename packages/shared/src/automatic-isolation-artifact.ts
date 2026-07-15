import { createHash } from "node:crypto"

export interface AutomaticIsolationIdentity {
  organizationId: string
  repositoryId: string
  workspacePath: string
  environmentKind: "transient"
  environmentName: string
}

export interface AutomaticIsolationProviderLock {
  source: string
  version: string
  constraints?: string
  hashes: string[]
}

export interface AutomaticIsolationTransformation {
  resourceAddress: string
  attribute: string
  sourceFile: string
  sourceExpression: string
  strategyRevision: string
}

export interface AutomaticIsolationArtifactManifest {
  contractVersion: 1
  sourceRevision: string
  identity: AutomaticIsolationIdentity
  suffix: string
  strategyRevision: string
  naming?: {
    separator: string
    maxLength: number
    allowedPattern: string
    collisionScope: "organization_repository_workspace_environment"
  }
  providerLocks: AutomaticIsolationProviderLock[]
  transformations: AutomaticIsolationTransformation[]
  files: Array<{ path: string; sha256: string }>
  artifactHash: string
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export function computeAutomaticIsolationArtifactHash(
  manifest: Omit<AutomaticIsolationArtifactManifest, "artifactHash">,
): string {
  return createHash("sha256").update(stableJson(manifest)).digest("hex")
}
