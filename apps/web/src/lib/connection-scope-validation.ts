import type { OrgConnection } from "./api"

export interface ProviderCredentialSignatureSummary {
  providerType: string
  displayName: string
  suggestedCredentialProviderType: "envvar" | "iam_role"
  exactEnvVars: string[]
  prefixEnvVars: string[]
}

export interface DraftEnvVarEntry {
  key: string
  value: string
}

export interface MissingRequirementSummary {
  environment: string
  workspace: string
}

export interface ScopeOptionState {
  value: string
  selected: boolean
  available: boolean
  conflicting: boolean
}

export interface ConnectionScopeValidationResult {
  environmentOptions: ScopeOptionState[]
  workspaceOptions: ScopeOptionState[]
  conflictMessages: string[]
  inferredProviderType: string
}

export interface ConnectionScopeValidationInput {
  connections: OrgConnection[]
  providerSignatures: ProviderCredentialSignatureSummary[]
  missingRequirements: MissingRequirementSummary[]
  editingConnectionId: string | null
  selectedConnectionType: "envvar" | "iam-role"
  selectedEnvironments: string[]
  selectedWorkspaces: string[]
  envVarEntries: DraftEnvVarEntry[]
  suggestedEnvironments: string[]
  suggestedWorkspaces: string[]
}

interface CredentialClaim {
  kind: "envvar" | "provider"
  key: string
  label: string
}

interface ExistingConnectionMetadata {
  id: string
  environmentScope: string[]
  workspaceScope: string[]
  claims: CredentialClaim[]
}

interface ConflictMatch {
  claim: CredentialClaim
}

function normalizeScopeList(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return []
  }

  return values.filter((value): value is string => typeof value === "string" && value.length > 0)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function matchesScopePattern(pattern: string, value: string): boolean {
  if (pattern === "*") {
    return true
  }

  if (!pattern.includes("*")) {
    return pattern === value
  }

  const regex = new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`)
  return regex.test(value)
}

function scopeValuesOverlap(left: string, right: string): boolean {
  return matchesScopePattern(left, right) || matchesScopePattern(right, left)
}

function scopeListOverlapsValue(scopes: string[], value: string): boolean {
  if (scopes.length === 0) {
    return true
  }

  return scopes.some((scope) => scopeValuesOverlap(scope, value))
}

function providerDisplayName(
  providerType: string,
  signatures: ProviderCredentialSignatureSummary[],
): string {
  const normalized = providerType.trim().toLowerCase()
  const match = signatures.find(
    (signature) => signature.providerType.trim().toLowerCase() === normalized,
  )
  if (match) {
    return match.displayName
  }

  return normalized === "aws" ? "AWS" : providerType.toUpperCase()
}

function inferProviderTypeFromEnvVarKeys(
  envVarKeys: string[],
  signatures: ProviderCredentialSignatureSummary[],
): string {
  if (envVarKeys.length === 0) {
    return "generic"
  }

  const normalizedKeys = envVarKeys
    .map((key) => key.trim().toUpperCase())
    .filter((key) => key.length > 0)

  if (normalizedKeys.length === 0) {
    return "generic"
  }

  let bestProvider = "generic"
  let bestScore = 0
  let isTie = false

  for (const signature of signatures) {
    const exactSet = new Set(signature.exactEnvVars.map((key) => key.toUpperCase()))
    const prefixes = signature.prefixEnvVars.map((prefix) => prefix.toUpperCase())

    let score = 0
    for (const key of normalizedKeys) {
      if (exactSet.has(key)) {
        score += 2
        continue
      }

      if (prefixes.some((prefix) => key.startsWith(prefix))) {
        score += 1
      }
    }

    if (score > bestScore) {
      bestScore = score
      bestProvider = signature.providerType
      isTie = false
      continue
    }

    if (score > 0 && score === bestScore) {
      isTie = true
    }
  }

  if (bestScore === 0 || isTie) {
    return "generic"
  }

  return bestProvider
}

function normalizeDraftEnvVarKeys(entries: DraftEnvVarEntry[]): string[] {
  return entries.map((entry) => entry.key.trim().toUpperCase()).filter((key) => key.length > 0)
}

function buildProviderClaim(
  providerType: string,
  signatures: ProviderCredentialSignatureSummary[],
): CredentialClaim | null {
  const normalized = providerType.trim().toLowerCase()
  if (!normalized || normalized === "generic") {
    return null
  }

  return {
    kind: "provider",
    key: `provider:${normalized}`,
    label: `${providerDisplayName(normalized, signatures)} credentials`,
  }
}

function buildEnvVarClaims(keys: string[]): CredentialClaim[] {
  return keys.map((key) => ({
    kind: "envvar",
    key: `envvar:${key}`,
    label: key,
  }))
}

function uniqueClaims(claims: CredentialClaim[]): CredentialClaim[] {
  const seen = new Set<string>()
  const unique: CredentialClaim[] = []

  for (const claim of claims) {
    if (seen.has(claim.key)) {
      continue
    }

    seen.add(claim.key)
    unique.push(claim)
  }

  return unique
}

function buildExistingConnectionMetadata(
  connection: OrgConnection,
  signatures: ProviderCredentialSignatureSummary[],
): ExistingConnectionMetadata {
  const config =
    typeof connection.config === "object" && connection.config !== null
      ? (connection.config as Record<string, unknown>)
      : {}

  const providerType = (
    typeof config.providerType === "string"
      ? config.providerType
      : (connection.providerType ?? connection.type)
  )
    .trim()
    .toLowerCase()

  const providerClaim = buildProviderClaim(providerType, signatures)
  const envVarKeys = Array.isArray(config.envVarKeys)
    ? config.envVarKeys
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim().toUpperCase())
        .filter((value) => value.length > 0)
    : []

  return {
    id: connection.id,
    environmentScope: normalizeScopeList(config.environmentScope),
    workspaceScope: normalizeScopeList(config.workspaceScope),
    claims: uniqueClaims([
      ...buildEnvVarClaims(envVarKeys),
      ...(providerClaim ? [providerClaim] : []),
    ]),
  }
}

function buildDraftClaims(input: ConnectionScopeValidationInput): {
  claims: CredentialClaim[]
  inferredProviderType: string
} {
  if (input.selectedConnectionType === "iam-role") {
    return {
      claims: uniqueClaims(
        [buildProviderClaim("aws", input.providerSignatures)].filter(
          (claim): claim is CredentialClaim => claim !== null,
        ),
      ),
      inferredProviderType: "aws",
    }
  }

  const envVarKeys = normalizeDraftEnvVarKeys(input.envVarEntries)
  const inferredProviderType = inferProviderTypeFromEnvVarKeys(envVarKeys, input.providerSignatures)
  const providerClaim = buildProviderClaim(inferredProviderType, input.providerSignatures)

  return {
    claims: uniqueClaims([
      ...buildEnvVarClaims(envVarKeys),
      ...(providerClaim ? [providerClaim] : []),
    ]),
    inferredProviderType,
  }
}

function conflictsForPair(
  environment: string,
  workspace: string,
  draftClaims: CredentialClaim[],
  existingConnections: ExistingConnectionMetadata[],
): ConflictMatch[] {
  if (draftClaims.length === 0) {
    return []
  }

  const matches: ConflictMatch[] = []

  for (const connection of existingConnections) {
    if (!scopeListOverlapsValue(connection.environmentScope, environment)) {
      continue
    }

    if (!scopeListOverlapsValue(connection.workspaceScope, workspace)) {
      continue
    }

    const existingKeys = new Set(connection.claims.map((claim) => claim.key))
    for (const draftClaim of draftClaims) {
      if (!existingKeys.has(draftClaim.key)) {
        continue
      }

      matches.push({ claim: draftClaim })
    }
  }

  return matches
}

function buildConflictMessages(
  selectedEnvironments: string[],
  selectedWorkspaces: string[],
  draftClaims: CredentialClaim[],
  existingConnections: ExistingConnectionMetadata[],
): string[] {
  if (selectedEnvironments.length === 0 || selectedWorkspaces.length === 0) {
    return []
  }

  const grouped = new Map<
    string,
    { label: string; kind: CredentialClaim["kind"]; environment: string; workspaces: Set<string> }
  >()

  for (const environment of selectedEnvironments) {
    for (const workspace of selectedWorkspaces) {
      for (const conflict of conflictsForPair(
        environment,
        workspace,
        draftClaims,
        existingConnections,
      )) {
        const key = `${conflict.claim.key}:${environment}`
        const existing = grouped.get(key)
        if (existing) {
          existing.workspaces.add(workspace)
          continue
        }

        grouped.set(key, {
          label: conflict.claim.label,
          kind: conflict.claim.kind,
          environment,
          workspaces: new Set([workspace]),
        })
      }
    }
  }

  return [...grouped.values()]
    .sort(
      (left, right) =>
        (left.kind === right.kind ? 0 : left.kind === "envvar" ? -1 : 1) ||
        left.label.localeCompare(right.label) ||
        left.environment.localeCompare(right.environment),
    )
    .map((group) => {
      const workspaces = [...group.workspaces].sort().join(", ")
      const verb = group.kind === "provider" ? "are" : "is"
      return `${group.label} ${verb} already defined for ${workspaces} in ${group.environment}.`
    })
}

function environmentOptionAvailable(
  environment: string,
  selectedWorkspaces: string[],
  knownWorkspaces: string[],
  draftClaims: CredentialClaim[],
  existingConnections: ExistingConnectionMetadata[],
): boolean {
  if (draftClaims.length === 0) {
    return true
  }

  const candidateWorkspaces = selectedWorkspaces.length > 0 ? selectedWorkspaces : knownWorkspaces
  if (candidateWorkspaces.length === 0) {
    return true
  }

  if (selectedWorkspaces.length > 0) {
    return candidateWorkspaces.every(
      (workspace) =>
        conflictsForPair(environment, workspace, draftClaims, existingConnections).length === 0,
    )
  }

  return candidateWorkspaces.some(
    (workspace) =>
      conflictsForPair(environment, workspace, draftClaims, existingConnections).length === 0,
  )
}

function workspaceOptionAvailable(
  workspace: string,
  selectedEnvironments: string[],
  knownEnvironments: string[],
  draftClaims: CredentialClaim[],
  existingConnections: ExistingConnectionMetadata[],
): boolean {
  if (draftClaims.length === 0) {
    return true
  }

  const candidateEnvironments =
    selectedEnvironments.length > 0 ? selectedEnvironments : knownEnvironments
  if (candidateEnvironments.length === 0) {
    return true
  }

  if (selectedEnvironments.length > 0) {
    return candidateEnvironments.every(
      (environment) =>
        conflictsForPair(environment, workspace, draftClaims, existingConnections).length === 0,
    )
  }

  return candidateEnvironments.some(
    (environment) =>
      conflictsForPair(environment, workspace, draftClaims, existingConnections).length === 0,
  )
}

function collectKnownEnvironmentOptions(input: ConnectionScopeValidationInput): string[] {
  const values = new Set<string>([
    ...input.suggestedEnvironments,
    ...input.selectedEnvironments,
    ...input.missingRequirements.map((requirement) => requirement.environment),
  ])

  for (const connection of input.connections) {
    const config =
      typeof connection.config === "object" && connection.config !== null
        ? (connection.config as Record<string, unknown>)
        : {}

    for (const scope of normalizeScopeList(config.environmentScope)) {
      values.add(scope)
    }
  }

  values.add("pr-*")
  return [...values].sort()
}

function collectKnownWorkspaceOptions(input: ConnectionScopeValidationInput): string[] {
  const values = new Set<string>([
    ...input.suggestedWorkspaces,
    ...input.selectedWorkspaces,
    ...input.missingRequirements.map((requirement) => requirement.workspace),
  ])

  for (const connection of input.connections) {
    const config =
      typeof connection.config === "object" && connection.config !== null
        ? (connection.config as Record<string, unknown>)
        : {}

    for (const scope of normalizeScopeList(config.workspaceScope)) {
      values.add(scope)
    }
  }

  values.add("infra/*")
  return [...values].sort()
}

export function buildConnectionScopeValidation(
  input: ConnectionScopeValidationInput,
): ConnectionScopeValidationResult {
  const existingConnections = input.connections
    .filter((connection) => connection.id !== input.editingConnectionId)
    .map((connection) => buildExistingConnectionMetadata(connection, input.providerSignatures))

  const { claims: draftClaims, inferredProviderType } = buildDraftClaims(input)
  const knownEnvironmentOptions = collectKnownEnvironmentOptions(input)
  const knownWorkspaceOptions = collectKnownWorkspaceOptions(input)

  const environmentOptions = knownEnvironmentOptions.map((environment) => {
    const selected = input.selectedEnvironments.includes(environment)
    const available = environmentOptionAvailable(
      environment,
      input.selectedWorkspaces,
      knownWorkspaceOptions,
      draftClaims,
      existingConnections,
    )
    const conflicting =
      selected &&
      input.selectedWorkspaces.some(
        (workspace) =>
          conflictsForPair(environment, workspace, draftClaims, existingConnections).length > 0,
      )

    return {
      value: environment,
      selected,
      available,
      conflicting,
    }
  })

  const workspaceOptions = knownWorkspaceOptions.map((workspace) => {
    const selected = input.selectedWorkspaces.includes(workspace)
    const available = workspaceOptionAvailable(
      workspace,
      input.selectedEnvironments,
      knownEnvironmentOptions,
      draftClaims,
      existingConnections,
    )
    const conflicting =
      selected &&
      input.selectedEnvironments.some(
        (environment) =>
          conflictsForPair(environment, workspace, draftClaims, existingConnections).length > 0,
      )

    return {
      value: workspace,
      selected,
      available,
      conflicting,
    }
  })

  return {
    environmentOptions,
    workspaceOptions,
    conflictMessages: buildConflictMessages(
      input.selectedEnvironments,
      input.selectedWorkspaces,
      draftClaims,
      existingConnections,
    ),
    inferredProviderType,
  }
}
