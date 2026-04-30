<script lang="ts">
  import { onMount } from "svelte"
  import AsyncLoader from "$lib/components/AsyncLoader.svelte"
  import StatusBadge from "$lib/components/StatusBadge.svelte"
  import CopyButton from "$lib/components/CopyButton.svelte"
  import ActionButton from "$lib/components/ActionButton.svelte"
  import {
    buildConnectionScopeValidation,
    type ProviderCredentialSignatureSummary,
  } from "$lib/connection-scope-validation"
  import {
    getOrgConnection,
    listEnvironments,
  } from "$lib/api"
  import type {
    EnvironmentGroup,
    OrgConnection,
  } from "$lib/api"

  type ConnectionType = "envvar" | "iam-role"
  type AwsSetupMethod = "terraform" | "cloudformation" | "cli"

  type PageData = {
    org: string
    connections: OrgConnection[]
    loadError: string | null
    yafflePrincipalArn: string | null
  }

  type EnvVarEntry = {
    key: string
    value: string
  }

  type MissingRequirement = {
    repo: string
    environment: string
    workspace: string
    provider: string
    recommended: string
  }

  type UnconfiguredConnectionRow = {
    id: string
    name: string
    provider: string
    strategy: string
    status: "unconfigured"
    scope: string
    note: string
    inferenceDetail?: string | null
    suggestedConnectionType: ConnectionType
    environmentScope: string[]
    workspaceScope: string[]
  }

  type ScopeExpansionSuggestion = {
    connectionId: string
    provider: string
    environmentScope: string[]
    workspaceScope: string[]
    repoList: string[]
    count: number
  }

  let { data }: { data: PageData } = $props()

  let showCreateModal = $state(false)
  let selectedConnectionType: ConnectionType = $state("envvar")
  let connectionsState = $state<OrgConnection[]>([])
  let initializedConnections = $state(false)
  let createError = $state("")
  let creating = $state(false)
  let connectionName = $state("")
  let selectedEnvironments = $state<string[]>([])
  let selectedWorkspaces = $state<string[]>([])
  let customEnvironmentInput = $state("")
  let customWorkspaceInput = $state("")
  let envVarEntries = $state<EnvVarEntry[]>([{ key: "", value: "" }])
  let envVarValueVisible = $state<boolean[]>([false])
  let roleArnInput = $state("")
  let awsRoleNameInput = $state("")
  let externalIdInput = $state("")
  let editingConnectionId = $state<string | null>(null)
  let loadingConnectionDetails = $state(false)
  let deletingConnectionId = $state<string | null>(null)
  let loadingConnections = $state(false)
  let connectionsError = $state<string | null>(null)
  let awsPrincipalArn = $state<string | null>(null)
  let suggestedEnvironments = $state<string[]>([])
  let suggestedWorkspaces = $state<string[]>([])
  let envSuggestionIndex = $state(0)
  let workspaceSuggestionIndex = $state(0)
  let missingRequirements = $state<MissingRequirement[]>([])
  let loadingRequirements = $state(false)
  let requirementsError = $state<string | null>(null)
  let knownProviderSignatures = $state<ProviderCredentialSignatureSummary[]>([])
  let awsSetupMethod = $state<AwsSetupMethod>("terraform")
  let copiedAwsField = $state<string | null>(null)
  let copiedAwsSnippet = $state(false)
  let awsBootstrapSeed = $state("")

  function providerLookupKeys(providerType: string): string[] {
    const normalized = providerType.trim().toLowerCase()
    if (!normalized) {
      return []
    }

    const keys = new Set<string>([normalized])
    const shortName = normalized.split("/").at(-1)?.trim()
    if (shortName) {
      keys.add(shortName)
    }

    return [...keys]
  }

  function normalizeConnectionProvider(connection: OrgConnection): string {
    const config = typeof connection.config === "object" && connection.config !== null
      ? connection.config as Record<string, unknown>
      : {}

    const provider = typeof config.providerType === "string"
      ? config.providerType
      : connection.providerType ?? connection.type

    return provider.trim().toLowerCase()
  }

  function summarizeScope(environmentScope: string[], workspaceScope: string[]): string {
    const environments = environmentScope.length > 0 ? environmentScope.join(", ") : "all environments"
    const workspaces = workspaceScope.length > 0 ? workspaceScope.join(", ") : "all workspaces"
    return `${environments} / ${workspaces}`
  }

  const knownProviderSetup = $derived.by((): Record<string, { label: string; suggestedConnectionType: ConnectionType }> =>
    Object.fromEntries(
      knownProviderSignatures.flatMap((signature) =>
        providerLookupKeys(signature.providerType).map((key) => [
          key,
          {
            label: signature.displayName,
            suggestedConnectionType: signature.suggestedCredentialProviderType === "iam_role"
              ? "iam-role"
              : "envvar",
          },
        ] as const)
      ),
    )
  )

  const existingConnections = $derived(
    connectionsState.map((connection) => {
      const config = typeof connection.config === "object" && connection.config !== null
        ? connection.config as Record<string, unknown>
        : {}

      const provider = typeof config.providerType === "string"
        ? config.providerType
        : connection.providerType ?? connection.type

      const strategy = typeof config.credentialProviderType === "string"
        ? config.credentialProviderType
        : connection.credentialProviderType ?? connection.type

      const scope = typeof config.scopeSummary === "string"
        ? config.scopeSummary
        : "All environments / all workspaces"

      const note = typeof config.note === "string"
        ? config.note
        : `Stored in ${connection.secretStore === "ssm" || connection.secretArn.startsWith("arn:aws:ssm:") ? "SSM Parameter Store" : connection.secretStore === "inline-config" ? "connection config" : "AWS secret storage"}.`

      const providerInference = typeof config.providerInference === "object" && config.providerInference !== null
        ? config.providerInference as Record<string, unknown>
        : null

      const inferenceDetail = providerInference
        && providerInference.inferred === true
        && providerInference.source === "envvar_keys"
        ? `Inferred provider type as ${provider} from env var names.`
        : null

      const status = connection.lastValidationError ? "failed" : "ready"

      return {
        id: connection.id,
        name: connection.name,
        provider,
        strategy,
        status,
        scope,
        note,
        inferenceDetail,
        editable: true,
        raw: connection,
      }
    }),
  )

  const scopeExpansionSuggestionsByConnectionId = $derived.by((): Map<string, ScopeExpansionSuggestion> => {
    const suggestions = new Map<string, ScopeExpansionSuggestion>()

    const connectionsByProvider = new Map<string, OrgConnection[]>()
    for (const connection of connectionsState) {
      const provider = normalizeConnectionProvider(connection)
      const existing = connectionsByProvider.get(provider)
      if (existing) {
        existing.push(connection)
      } else {
        connectionsByProvider.set(provider, [connection])
      }
    }

    const groupedRequirements = new Map<string, MissingRequirement[]>()
    for (const requirement of missingRequirements) {
      const provider = requirement.provider.trim().toLowerCase()
      const existing = groupedRequirements.get(provider)
      if (existing) {
        existing.push(requirement)
      } else {
        groupedRequirements.set(provider, [requirement])
      }
    }

    for (const [provider, requirements] of groupedRequirements) {
      const existingConnectionsForProvider = connectionsByProvider.get(provider) ?? []
      if (existingConnectionsForProvider.length !== 1) {
        continue
      }

      const connection = existingConnectionsForProvider[0]
      const environments = new Set<string>()
      const workspaces = new Set<string>()
      const repos = new Set<string>()

      for (const requirement of requirements) {
        environments.add(requirement.environment)
        workspaces.add(requirement.workspace)
        repos.add(requirement.repo)
      }

      suggestions.set(connection.id, {
        connectionId: connection.id,
        provider,
        environmentScope: [...environments].sort(),
        workspaceScope: [...workspaces].sort(),
        repoList: [...repos].sort(),
        count: requirements.length,
      })
    }

    return suggestions
  })

  const aggregatedUnconfiguredConnections = $derived.by((): UnconfiguredConnectionRow[] => {
    const grouped = new Map<string, {
      provider: string
      environments: Set<string>
      workspaces: Set<string>
      repos: Set<string>
      count: number
    }>()

    for (const requirement of missingRequirements) {
      const key = requirement.provider.toLowerCase()
      if (!knownProviderSetup[key]) {
        continue
      }

      const existingConnectionsForProvider = connectionsState.filter((connection) =>
        normalizeConnectionProvider(connection) === key
      )
      if (existingConnectionsForProvider.length === 1) {
        continue
      }

      const existing = grouped.get(key)
      if (existing) {
        existing.environments.add(requirement.environment)
        existing.workspaces.add(requirement.workspace)
        existing.repos.add(requirement.repo)
        existing.count += 1
        continue
      }

      grouped.set(key, {
        provider: key,
        environments: new Set([requirement.environment]),
        workspaces: new Set([requirement.workspace]),
        repos: new Set([requirement.repo]),
        count: 1,
      })
    }

    return [...grouped.entries()].map(([provider, entry]) => {
      const setup = knownProviderSetup[provider]
      const environmentScope = [...entry.environments].sort()
      const workspaceScope = [...entry.workspaces].sort()
      const repoList = [...entry.repos].sort().join(", ")
      const strategy = setup.suggestedConnectionType === "iam-role"
        ? "AWS IAM role"
        : "Environment variables"

      return {
        id: `missing:${provider}`,
        name: setup.label,
        provider,
        strategy,
        status: "unconfigured",
        scope: `${environmentScope.join(", ")} / ${workspaceScope.join(", ")}`,
        note: `${entry.count} workspace${entry.count === 1 ? "" : "s"} from ${repoList} waiting for this connection.`,
        suggestedConnectionType: setup.suggestedConnectionType,
        environmentScope,
        workspaceScope,
      }
    })
  })

  const displayedConnections = $derived([
    ...existingConnections,
    ...aggregatedUnconfiguredConnections,
  ])
  const isEditing = $derived(editingConnectionId !== null)
  const scopeValidation = $derived.by(() =>
    buildConnectionScopeValidation({
      connections: connectionsState,
      providerSignatures: knownProviderSignatures,
      missingRequirements,
      editingConnectionId,
      selectedConnectionType,
      selectedEnvironments,
      selectedWorkspaces,
      envVarEntries,
      suggestedEnvironments,
      suggestedWorkspaces,
    })
  )
  const knownEnvironmentOptions = $derived(scopeValidation.environmentOptions)
  const knownWorkspaceOptions = $derived(scopeValidation.workspaceOptions)
  const scopeConflictMessages = $derived(scopeValidation.conflictMessages)

  const matchingEnvironmentSuggestions = $derived.by(() => {
    const query = customEnvironmentInput.trim().toLowerCase()
    if (!query) {
      return []
    }

    return knownEnvironmentOptions
      .filter((option) =>
        option.value.toLowerCase().includes(query) && !selectedEnvironments.includes(option.value)
      )
      .filter((option) => option.available)
      .map((option) => option.value)
      .slice(0, 8)
  })

  const matchingWorkspaceSuggestions = $derived.by(() => {
    const query = customWorkspaceInput.trim().toLowerCase()
    if (!query) {
      return []
    }

    return knownWorkspaceOptions
      .filter((option) =>
        option.value.toLowerCase().includes(query) && !selectedWorkspaces.includes(option.value)
      )
      .filter((option) => option.available)
      .map((option) => option.value)
      .slice(0, 8)
  })

  function slugPart(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      || "main"
  }

  const awsBootstrapValues = $derived.by(() => {
    const scopedEnvironment = selectedEnvironments.find((value) => !value.includes("*")) ?? "main"
    const environmentPart = slugPart(scopedEnvironment)
    const orgPart = slugPart(data.org)
    const seed = awsBootstrapSeed || "preview"

    return {
      suggestedRoleName: `yaffle-assume-role-${environmentPart}-use1`,
      suggestedExternalId: `yaffle-${orgPart}-${environmentPart}-${seed}`,
      yafflePrincipalArn: awsPrincipalArn ?? "<org-broker-role-not-configured>",
    }
  })

  const awsTerraformSnippet = $derived.by(() => `module "yaffle_bootstrap" {
  source = "git::https://github.com/yaffle-dot-dev/yaffle.git//infra_modules/public/bootstrap-yaffle/aws?ref=main"

  yaffle_principal_arn = "${awsBootstrapValues.yafflePrincipalArn}"
  external_id         = "${externalIdInput.trim() || awsBootstrapValues.suggestedExternalId}"
  role_name           = "${awsRoleNameInput.trim() || awsBootstrapValues.suggestedRoleName}"

  environment = "${selectedEnvironments[0] ?? "main"}"
}

output "yaffle_role_arn" {
  value = module.yaffle_bootstrap.role_arn
}
`)

  const awsCloudFormationSnippet = $derived.by(() => `AWSTemplateFormatVersion: "2010-09-09"
Description: "Yaffle bootstrap role"

Parameters:
  YafflePrincipalArn:
    Type: String
    Default: "${awsBootstrapValues.yafflePrincipalArn}"
  ExternalId:
    Type: String
    Default: "${externalIdInput.trim() || awsBootstrapValues.suggestedExternalId}"
  RoleName:
    Type: String
    Default: "${awsRoleNameInput.trim() || awsBootstrapValues.suggestedRoleName}"

Resources:
  YaffleRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Ref RoleName
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Principal:
              AWS: !Ref YafflePrincipalArn
            Action: "sts:AssumeRole"
            Condition:
              StringEquals:
                "sts:ExternalId": !Ref ExternalId

  YaffleAdminAccess:
    Type: AWS::IAM::ManagedPolicy
    Properties:
      Description: "MVP default broad permissions for Yaffle"
      Roles:
        - !Ref YaffleRole
      PolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Action: "*"
            Resource: "*"

Outputs:
  RoleArn:
    Value: !GetAtt YaffleRole.Arn`)

  const awsCliSnippet = $derived.by(() => `cat > trust-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "${awsBootstrapValues.yafflePrincipalArn}"
      },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": {
          "sts:ExternalId": "${externalIdInput.trim() || awsBootstrapValues.suggestedExternalId}"
        }
      }
    }
  ]
}
EOF

aws iam create-role \
  --role-name ${awsRoleNameInput.trim() || awsBootstrapValues.suggestedRoleName} \
  --assume-role-policy-document file://trust-policy.json

aws iam attach-role-policy \
  --role-name ${awsRoleNameInput.trim() || awsBootstrapValues.suggestedRoleName} \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess

# Docs: optional least-privilege customization
# https://yaffle.local:6969/docs/guides/aws/`)

  const activeAwsSnippet = $derived.by(() => {
    switch (awsSetupMethod) {
      case "terraform":
        return awsTerraformSnippet
      case "cloudformation":
        return awsCloudFormationSnippet
      case "cli":
        return awsCliSnippet
    }
  })

  function collectScopeSuggestions(groups: EnvironmentGroup[]): void {
    const environments = new Set<string>()
    const workspaces = new Set<string>()

    for (const group of groups) {
      environments.add(group.environmentName)
      for (const workspace of group.workspaces) {
        workspaces.add(workspace.workspacePath)
      }
    }

    suggestedEnvironments = [...environments].sort()
    suggestedWorkspaces = [...workspaces].sort()
  }

  function openCreateModal(type: ConnectionType = "envvar"): void {
    editingConnectionId = null
    selectedConnectionType = type
    awsSetupMethod = "terraform"
    copiedAwsField = null
    copiedAwsSnippet = false
    awsBootstrapSeed = `${Date.now().toString(36).slice(-6)}`
    createError = ""
    connectionName = ""
    selectedEnvironments = []
    selectedWorkspaces = []
    customEnvironmentInput = ""
    customWorkspaceInput = ""
    envVarEntries = [{ key: "", value: "" }]
    envVarValueVisible = [false]
    roleArnInput = ""
    awsRoleNameInput = ""
    externalIdInput = ""
    showCreateModal = true
  }

  function closeCreateModal(): void {
    showCreateModal = false
    editingConnectionId = null
  }

  async function copyAwsValue(id: string, value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
      copiedAwsField = id
      setTimeout(() => {
        if (copiedAwsField === id) {
          copiedAwsField = null
        }
      }, 1200)
    } catch {
      copiedAwsField = null
    }
  }

  async function copyAwsSnippet(): Promise<void> {
    try {
      await navigator.clipboard.writeText(activeAwsSnippet)
      copiedAwsSnippet = true
      setTimeout(() => {
        copiedAwsSnippet = false
      }, 1200)
    } catch {
      copiedAwsSnippet = false
    }
  }

  async function editConnection(connection: OrgConnection): Promise<void> {
    loadingConnectionDetails = true
    createError = ""

    try {
      const result = await getOrgConnection(data.org, connection.id)
      const detail = result.data
      const config = detail.config ?? {}
      const secret = typeof detail.secret === "object" && detail.secret !== null
        ? detail.secret as Record<string, unknown>
        : {}

      editingConnectionId = detail.id
      selectedConnectionType = detail.credentialProviderType === "iam_role" ? "iam-role" : "envvar"
      awsSetupMethod = "terraform"
      copiedAwsField = null
      copiedAwsSnippet = false
      awsBootstrapSeed = `${Date.now().toString(36).slice(-6)}`
      connectionName = detail.name
      selectedEnvironments = Array.isArray(config.environmentScope)
        ? config.environmentScope.filter((value: unknown): value is string => typeof value === "string")
        : []
      selectedWorkspaces = Array.isArray(config.workspaceScope)
        ? config.workspaceScope.filter((value: unknown): value is string => typeof value === "string")
        : []
      customEnvironmentInput = ""
      customWorkspaceInput = ""
      envVarEntries = Array.isArray(secret.envVars)
        ? secret.envVars
            .filter((entry): entry is { key: string; value: string } => typeof entry?.key === "string" && typeof entry?.value === "string")
            .map((entry) => ({ key: entry.key, value: entry.value }))
        : [{ key: "", value: "" }]
      envVarValueVisible = Array.from({ length: envVarEntries.length }, () => false)
      roleArnInput = typeof config.roleArn === "string" ? config.roleArn : ""
      if (roleArnInput.includes(":role/")) {
        awsRoleNameInput = roleArnInput.split(":role/")[1] ?? ""
      } else {
        awsRoleNameInput = ""
      }
      externalIdInput = typeof config.externalId === "string" ? config.externalId : ""
      showCreateModal = true
    } catch (err) {
      createError = err instanceof Error ? err.message : String(err)
    } finally {
      loadingConnectionDetails = false
    }
  }

  function configureUnconfiguredConnection(connection: UnconfiguredConnectionRow): void {
    openCreateModal(connection.suggestedConnectionType)
    connectionName = connection.name
    selectedEnvironments = [...connection.environmentScope]
    selectedWorkspaces = [...connection.workspaceScope]
  }

  function buildScopeExpansionNote(suggestion: ScopeExpansionSuggestion): string {
    const repoList = suggestion.repoList.join(", ")
    return `${suggestion.count} workspace${suggestion.count === 1 ? "" : "s"} from ${repoList} are waiting outside this connection's current scope. Add ${summarizeScope(suggestion.environmentScope, suggestion.workspaceScope)}.`
  }

  async function expandConnectionScope(connection: OrgConnection): Promise<void> {
    const suggestion = scopeExpansionSuggestionsByConnectionId.get(connection.id)
    if (!suggestion) {
      await editConnection(connection)
      return
    }

    await editConnection(connection)

    selectedEnvironments = [...new Set([...selectedEnvironments, ...suggestion.environmentScope])]
    selectedWorkspaces = [...new Set([...selectedWorkspaces, ...suggestion.workspaceScope])]
  }

  function parseLines(value: string): string[] {
    return value
      .split(/\n|,/)
      .map((item) => item.trim())
      .filter(Boolean)
  }

  function toggleScopeValue(kind: "environment" | "workspace", value: string): void {
    const current = kind === "environment" ? selectedEnvironments : selectedWorkspaces
    const setter = kind === "environment"
      ? (next: string[]) => selectedEnvironments = next
      : (next: string[]) => selectedWorkspaces = next

    if (current.includes(value)) {
      setter(current.filter((item) => item !== value))
    } else {
      setter([...current, value])
    }
  }

  function addCustomScopeValue(kind: "environment" | "workspace"): void {
    const input = kind === "environment" ? customEnvironmentInput : customWorkspaceInput
    const values = parseLines(input)
    if (values.length === 0) {
      return
    }

    const current = kind === "environment" ? selectedEnvironments : selectedWorkspaces
    const unique = [...new Set([...current, ...values])]

    if (kind === "environment") {
      selectedEnvironments = unique
      customEnvironmentInput = ""
    } else {
      selectedWorkspaces = unique
      customWorkspaceInput = ""
    }
  }

  function removeScopeValue(kind: "environment" | "workspace", value: string): void {
    if (kind === "environment") {
      selectedEnvironments = selectedEnvironments.filter((item) => item !== value)
    } else {
      selectedWorkspaces = selectedWorkspaces.filter((item) => item !== value)
    }
  }

  function applyScopeSuggestion(kind: "environment" | "workspace", value: string): void {
    if (kind === "environment") {
      selectedEnvironments = selectedEnvironments.includes(value)
        ? selectedEnvironments
        : [...selectedEnvironments, value]
      customEnvironmentInput = ""
      return
    }

    selectedWorkspaces = selectedWorkspaces.includes(value)
      ? selectedWorkspaces
      : [...selectedWorkspaces, value]
    customWorkspaceInput = ""
  }

  function handleScopeInputKeydown(kind: "environment" | "workspace", event: KeyboardEvent): void {
    const suggestions = kind === "environment"
      ? matchingEnvironmentSuggestions
      : matchingWorkspaceSuggestions

    if (event.key === "ArrowDown" && suggestions.length > 0) {
      event.preventDefault()
      if (kind === "environment") {
        envSuggestionIndex = (envSuggestionIndex + 1) % suggestions.length
      } else {
        workspaceSuggestionIndex = (workspaceSuggestionIndex + 1) % suggestions.length
      }
      return
    }

    if (event.key === "ArrowUp" && suggestions.length > 0) {
      event.preventDefault()
      if (kind === "environment") {
        envSuggestionIndex = (envSuggestionIndex - 1 + suggestions.length) % suggestions.length
      } else {
        workspaceSuggestionIndex = (workspaceSuggestionIndex - 1 + suggestions.length) % suggestions.length
      }
      return
    }

    if (event.key === "Tab" && suggestions.length > 0) {
      const rawValue = kind === "environment" ? customEnvironmentInput : customWorkspaceInput
      if (!rawValue.trim()) {
        return
      }

      event.preventDefault()
      const index = kind === "environment" ? envSuggestionIndex : workspaceSuggestionIndex
      const picked = suggestions[index] ?? suggestions[0]
      if (picked) {
        applyScopeSuggestion(kind, picked)
      }
      return
    }

    if (event.key === "Enter") {
      event.preventDefault()
      if (suggestions.length > 0) {
        const index = kind === "environment" ? envSuggestionIndex : workspaceSuggestionIndex
        const picked = suggestions[index] ?? suggestions[0]
        if (picked) {
          applyScopeSuggestion(kind, picked)
          return
        }
      }

      addCustomScopeValue(kind)
    }
  }

  $effect(() => {
    if (matchingEnvironmentSuggestions.length === 0) {
      envSuggestionIndex = 0
      return
    }

    if (envSuggestionIndex >= matchingEnvironmentSuggestions.length) {
      envSuggestionIndex = 0
    }
  })

  $effect(() => {
    if (matchingWorkspaceSuggestions.length === 0) {
      workspaceSuggestionIndex = 0
      return
    }

    if (workspaceSuggestionIndex >= matchingWorkspaceSuggestions.length) {
      workspaceSuggestionIndex = 0
    }
  })

  $effect(() => {
    if (!showCreateModal || editingConnectionId || selectedConnectionType !== "iam-role") {
      return
    }

    if (!externalIdInput.trim()) {
      externalIdInput = awsBootstrapValues.suggestedExternalId
    }

    if (!awsRoleNameInput.trim()) {
      awsRoleNameInput = awsBootstrapValues.suggestedRoleName
    }

    if (!connectionName.trim()) {
      const scopedEnvironment = selectedEnvironments.find((value) => !value.includes("*")) ?? "main"
      connectionName = `AWS ${scopedEnvironment}`
    }
  })

  function normalizeEnvVarEntries(entries: EnvVarEntry[]): Array<{ key: string; value: string }> {
    return entries
      .map((entry) => ({ key: entry.key.trim(), value: entry.value.trim() }))
      .filter((entry) => entry.key.length > 0 || entry.value.length > 0)
      .map((entry) => {
        if (!entry.key || !entry.value) {
          throw new Error("Each credential row must include both a key and a value")
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.key)) {
          throw new Error(`Invalid environment variable name: ${entry.key}`)
        }
        return entry
      })
  }

  function hasCompleteEnvVarEntries(entries: EnvVarEntry[]): boolean {
    try {
      return normalizeEnvVarEntries(entries).length > 0
    } catch {
      return false
    }
  }

  function isValidIamRoleArn(value: string): boolean {
    return /^arn:aws(-[a-z]+)?:iam::\d{12}:role\/.+$/.test(value.trim())
  }

  function addEnvVarEntry(): void {
    envVarEntries = [...envVarEntries, { key: "", value: "" }]
    envVarValueVisible = [...envVarValueVisible, false]
  }

  function updateEnvVarEntry(index: number, field: "key" | "value", value: string): void {
    envVarEntries = envVarEntries.map((entry, entryIndex) =>
      entryIndex === index ? { ...entry, [field]: value } : entry
    )
  }

  function removeEnvVarEntry(index: number): void {
    if (envVarEntries.length === 1) {
      envVarEntries = [{ key: "", value: "" }]
      envVarValueVisible = [false]
      return
    }

    envVarEntries = envVarEntries.filter((_, entryIndex) => entryIndex !== index)
    envVarValueVisible = envVarValueVisible.filter((_, entryIndex) => entryIndex !== index)
  }

  function toggleEnvVarValueVisibility(index: number): void {
    envVarValueVisible = envVarValueVisible.map((visible, entryIndex) =>
      entryIndex === index ? !visible : visible,
    )
  }

  async function submitCreateConnection(): Promise<void> {
    createError = ""
    creating = true

    try {
      const environmentScope = selectedEnvironments
      const workspaceScope = selectedWorkspaces

      const payload = selectedConnectionType === "envvar"
        ? {
            name: connectionName,
            providerType: "generic",
            credentialProviderType: "envvar",
            environmentScope,
            workspaceScope,
            envVars: normalizeEnvVarEntries(envVarEntries),
          }
        : {
            name: connectionName,
            providerType: "aws",
            credentialProviderType: "iam_role",
            environmentScope,
            workspaceScope,
            roleArn: roleArnInput,
            externalId: externalIdInput || undefined,
          }

      if (selectedConnectionType === "iam-role" && !isValidIamRoleArn(roleArnInput)) {
        throw new Error("Role ARN must be a valid AWS IAM role ARN")
      }

      const response = await fetch(
        editingConnectionId
          ? `/api/orgs/${data.org}/connections/${editingConnectionId}`
          : `/api/orgs/${data.org}/connections`,
        {
        method: editingConnectionId ? "PATCH" : "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      })

      const body = await response.json() as {
        data?: OrgConnection
        error?: { message?: string }
      }

      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Failed to create connection")
      }

      connectionsState = editingConnectionId
        ? connectionsState.map((connection) => connection.id === body.data!.id ? body.data! : connection)
        : [body.data, ...connectionsState]
      closeCreateModal()
      void loadMissingRequirements()
    } catch (err) {
      createError = err instanceof Error ? err.message : String(err)
    } finally {
      creating = false
    }
  }

  async function deleteConnectionAction(connection: OrgConnection): Promise<void> {
    const confirmed = window.confirm(`Delete ${connection.name}? Runs depending on it may become blocked until another connection is configured.`)
    if (!confirmed) {
      return
    }

    deletingConnectionId = connection.id
    try {
      const response = await fetch(`/api/orgs/${data.org}/connections/${connection.id}`, {
        method: "DELETE",
        credentials: "include",
      })

      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null
        throw new Error(body?.error?.message ?? "Failed to delete connection")
      }

      connectionsState = connectionsState.filter((item) => item.id !== connection.id)
      void loadMissingRequirements()
    } catch (err) {
      createError = err instanceof Error ? err.message : String(err)
    } finally {
      deletingConnectionId = null
    }
  }

  async function loadConnections(): Promise<void> {
    loadingConnections = true
    connectionsError = null

    try {
      const response = await fetch(`/api/orgs/${data.org}/connections`, {
        credentials: "include",
      })

      const body = await response.json() as {
        data?: OrgConnection[]
        error?: { message?: string }
      }

      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Failed to load connections")
      }

      connectionsState = body.data
    } catch (err) {
      connectionsError = err instanceof Error ? err.message : String(err)
    } finally {
      loadingConnections = false
    }
  }

  async function loadScopeSuggestions(): Promise<void> {
    try {
      const result = await listEnvironments({ org: data.org })
      collectScopeSuggestions(result.data)
    } catch {
      suggestedEnvironments = []
      suggestedWorkspaces = []
    }
  }

  async function loadAwsPrincipal(): Promise<void> {
    try {
      const response = await fetch(`/api/orgs/${data.org}/aws-bootstrap-principal`, {
        credentials: "include",
      })

      const body = await response.json() as {
        data?: { principalArn: string }
      }

      if (response.ok && body.data?.principalArn) {
        awsPrincipalArn = body.data.principalArn
      }
    } catch {
      awsPrincipalArn = null
    }
  }

  async function loadMissingRequirements(): Promise<void> {
    loadingRequirements = true
    requirementsError = null

    try {
      const response = await fetch(`/api/orgs/${data.org}/connection-requirements`, {
        credentials: "include",
      })

      const body = await response.json() as {
        data?: MissingRequirement[]
        error?: { message?: string }
      }

      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Failed to load missing connection requirements")
      }

      missingRequirements = body.data
    } catch (err) {
      requirementsError = err instanceof Error ? err.message : String(err)
    } finally {
      loadingRequirements = false
    }
  }

  async function loadProviderSignatures(): Promise<void> {
    try {
      const response = await fetch(`/api/orgs/${data.org}/provider-credential-signatures`, {
        credentials: "include",
      })

      const body = await response.json() as {
        data?: ProviderCredentialSignatureSummary[]
      }

      if (response.ok && body.data) {
        knownProviderSignatures = body.data
      }
    } catch {
      knownProviderSignatures = []
    }
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && showCreateModal) {
      closeCreateModal()
    }
  }

  $effect(() => {
    if (!showCreateModal) {
      return
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"

    return () => {
      document.body.style.overflow = previousOverflow
    }
  })

  onMount(() => {
    awsPrincipalArn = data.yafflePrincipalArn

    if (!initializedConnections) {
      initializedConnections = true
      void loadConnections()
      void loadScopeSuggestions()
      void loadMissingRequirements()
      void loadAwsPrincipal()
      void loadProviderSignatures()
    }
  })
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<section class="space-y-2 border-b border-border pb-6">
  <div class="flex items-end justify-between gap-4">
    <div>
      <h2 class="text-2xl font-semibold text-text">Connections</h2>
      <p class="mt-1 max-w-3xl text-sm text-text-muted">
        Manage the credentials this organization uses across environments and workspaces.
      </p>
    </div>

    <ActionButton onclick={() => openCreateModal()}>
      Create connection
    </ActionButton>
  </div>
</section>

{#if connectionsError || data.loadError}
  <div class="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
    {connectionsError ?? data.loadError}
  </div>
{/if}

{#if loadingConnections}
  <AsyncLoader
    title="Loading connections"
    message="Fetching existing connection inventory for this organization."
  />
{/if}

{#if loadingRequirements}
  <AsyncLoader
    title="Detecting unconfigured connections"
    message="Checking known provider requirements from recent deployments."
  />
{:else if requirementsError}
  <div class="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
    {requirementsError}
  </div>
{/if}

<section class="space-y-8">
  <div>
    <h3 class="text-sm font-medium text-text">Existing connections</h3>
    {#if displayedConnections.length === 0}
      <div class="mt-3 rounded-lg border border-dashed border-border px-4 py-6 text-sm text-text-dim">
        No connections found yet.
      </div>
    {:else}
      <div class="mt-3 divide-y divide-border border-y border-border">
        {#each displayedConnections as connection}
          {@const scopeExpansionSuggestion = "raw" in connection
            ? scopeExpansionSuggestionsByConnectionId.get(connection.id) ?? null
            : null}
          <div class="flex flex-col gap-4 py-4 md:flex-row md:items-start md:justify-between">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <div class="text-sm font-medium text-text">{connection.name}</div>
                {#if connection.status !== "ready"}
                  <StatusBadge status={connection.status} />
                {/if}
              </div>

              <div class="mt-1 text-sm text-text-muted">{connection.note}</div>
              <div class="mt-2 text-xs text-text-dim">
                {connection.strategy} · {connection.scope}
              </div>
              {#if connection.inferenceDetail}
                <div class="mt-1 text-xs text-text-dim">
                  {connection.inferenceDetail}
                </div>
              {/if}
              {#if scopeExpansionSuggestion}
                <div class="mt-2 text-xs text-amber-300">
                  {buildScopeExpansionNote(scopeExpansionSuggestion)}
                </div>
              {/if}
            </div>

            <div class="flex gap-2">
              {#if "raw" in connection}
                {#if scopeExpansionSuggestion}
                  <button
                    class="rounded-md border border-amber-500/40 px-2.5 py-1.5 text-xs text-amber-200 transition hover:bg-amber-500/10 disabled:opacity-50"
                    onclick={() => expandConnectionScope(connection.raw)}
                    disabled={loadingConnectionDetails}
                  >
                    Expand scope
                  </button>
                {/if}
                <button
                  class="rounded-md border border-border px-2.5 py-1.5 text-xs text-text-muted transition hover:bg-surface-raised disabled:opacity-50"
                  onclick={() => editConnection(connection.raw)}
                  disabled={loadingConnectionDetails}
                >
                  {#if loadingConnectionDetails}Loading...{:else}Edit{/if}
                </button>
                <button
                  class="rounded-md border border-border px-2.5 py-1.5 text-xs text-text-muted transition hover:bg-surface-raised disabled:opacity-50"
                  onclick={() => deleteConnectionAction(connection.raw)}
                  disabled={deletingConnectionId === connection.id}
                >
                  {#if deletingConnectionId === connection.id}Deleting...{:else}Delete{/if}
                </button>
              {:else}
                <button
                  class="rounded-md border border-border px-2.5 py-1.5 text-xs text-text-muted transition hover:bg-surface-raised"
                  onclick={() => configureUnconfiguredConnection(connection)}
                >
                  Set up
                </button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</section>

{#if showCreateModal}
  <div class="fixed inset-0 z-50 overflow-y-auto overscroll-contain" aria-modal="true" role="dialog" aria-labelledby="create-connection-title">
    <div
      class="absolute inset-0 bg-black/40"
      role="button"
      tabindex="0"
      aria-label="Close create connection drawer"
      onclick={closeCreateModal}
      onkeydown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          closeCreateModal()
        }
      }}
    ></div>

    <div class="relative min-h-full">
      <div class="mt-[10vh] w-full rounded-t-2xl border-t border-border bg-surface-raised shadow-2xl">
        <div class="flex justify-center px-6 pt-3">
          <div class="h-1.5 w-12 rounded-full bg-border"></div>
        </div>

        <div class="mx-auto max-w-5xl flex items-start justify-between gap-4 border-b border-border px-6 py-5">
          <div>
            <h3 id="create-connection-title" class="text-lg font-semibold text-text">{isEditing ? "Edit connection" : "Create connection"}</h3>
            <p class="mt-1 text-sm text-text-muted">
              {#if isEditing}
                Update how this connection is scoped and delivered.
              {:else}
                Add a reusable credential for this organization.
              {/if}
            </p>
          </div>

          <button
            class="rounded-md border border-border px-2.5 py-1.5 text-sm text-text-muted transition hover:bg-surface"
            onclick={closeCreateModal}
          >
            Close
          </button>
        </div>

        <div class="mx-auto max-w-5xl space-y-6 px-6 py-6 pb-10">
          <section class="space-y-3">
            <h4 class="text-sm font-medium text-text">1. Choose connection type</h4>

            <div class="space-y-2">
              <label class="text-sm text-text-dim" for="connection-type">Connection type</label>
              <div class="relative">
                <select
                  id="connection-type"
                  bind:value={selectedConnectionType}
                  class={`w-full appearance-none rounded-lg border px-3 py-2.5 pr-10 text-sm outline-none transition ${isEditing
                    ? "border-border bg-surface-raised text-text-muted"
                    : "border-border bg-surface text-text focus:border-border-strong"}`}
                  disabled={isEditing}
                >
                  <option value="envvar">API token / env vars</option>
                  <option value="iam-role">AWS role</option>
                </select>

                <div class="pointer-events-none absolute inset-y-0 right-3 flex items-center text-text-dim">
                  <svg class="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M4 6l4 4 4-4" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </div>
              </div>
            </div>

            <p class="text-sm text-text-muted">
              {#if selectedConnectionType === "envvar"}
                Use this for providers that expect tokens or OAuth values through environment variables.
              {:else}
                Use this when Yaffle should assume an AWS IAM role and mint short-lived credentials automatically.
              {/if}
            </p>
          </section>

          <section class="space-y-3 border-t border-border pt-6">
            <h4 class="text-sm font-medium text-text">2. Connection details</h4>

            {#if selectedConnectionType === "envvar"}
              <div class="space-y-4 text-sm">
                <div>
                  <div class="text-text-dim">Name</div>
                  <input
                    bind:value={connectionName}
                    class="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-text outline-none transition focus:border-border-strong"
                    placeholder="Cloudflare Production"
                  />
                </div>

                <div>
                  <div class="text-text-dim">Credential fields</div>
                  <div class="mt-1 space-y-2">
                    {#each envVarEntries as entry, index}
                      <div class="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                        <input
                          value={entry.key}
                          class="w-full rounded-md border border-border bg-surface px-3 py-2 text-text outline-none transition focus:border-border-strong"
                          placeholder="Variable name"
                          oninput={(event) => updateEnvVarEntry(index, "key", (event.currentTarget as HTMLInputElement).value)}
                        />
                        <div class="relative">
                          <input
                            type={envVarValueVisible[index] ? "text" : "password"}
                            value={entry.value}
                            class="w-full rounded-md border border-border bg-surface px-3 py-2 pr-10 text-text outline-none transition focus:border-border-strong"
                            placeholder="Secure value"
                            oninput={(event) => updateEnvVarEntry(index, "value", (event.currentTarget as HTMLInputElement).value)}
                          />
                          <button
                            type="button"
                            class="absolute inset-y-0 right-2 inline-flex items-center text-text-dim transition hover:text-text"
                            onclick={() => toggleEnvVarValueVisibility(index)}
                            title={envVarValueVisible[index] ? "Hide value" : "Reveal value"}
                            aria-label={envVarValueVisible[index] ? "Hide value" : "Reveal value"}
                          >
                            {#if envVarValueVisible[index]}
                              <svg class="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                                <path d="M2 2l12 12" stroke-linecap="round" />
                                <path d="M6.3 6.3A2.4 2.4 0 0 0 9.7 9.7" stroke-linecap="round" />
                                <path d="M1.5 8s2.2-4 6.5-4c1.2 0 2.3.3 3.2.8M14.5 8s-2.2 4-6.5 4c-1.2 0-2.3-.3-3.2-.8" stroke-linecap="round" />
                              </svg>
                            {:else}
                              <svg class="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                                <path d="M1.5 8s2.2-4 6.5-4 6.5 4 6.5 4-2.2 4-6.5 4-6.5-4-6.5-4z" />
                                <circle cx="8" cy="8" r="2.2" />
                              </svg>
                            {/if}
                          </button>
                        </div>
                        <button
                          type="button"
                          class="rounded-md border border-border px-3 py-2 text-sm text-text-muted transition hover:bg-surface-raised"
                          onclick={() => removeEnvVarEntry(index)}
                        >
                          Remove
                        </button>
                      </div>
                    {/each}
                    <button
                      type="button"
                      class="rounded-md border border-border px-3 py-2 text-sm text-text transition hover:bg-surface-raised"
                      onclick={addEnvVarEntry}
                    >
                      Add variable
                    </button>
                  </div>
                </div>
              </div>
            {:else}
              <div class="space-y-4 text-sm">
                <div>
                  <div class="text-text-dim">Name</div>
                  <input
                    bind:value={connectionName}
                    class="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-text outline-none transition focus:border-border-strong"
                    placeholder="AWS Production"
                  />
                </div>

                {#if isEditing}
                  <div class="rounded-lg border border-border bg-surface p-4 text-sm text-text-dim">
                    AWS role ARN and external ID are fixed after creation. To switch this connection to a
                    different role, create a new AWS connection and then narrow or delete this one.
                  </div>
                {:else}
                  <div class="rounded-lg border border-border bg-surface p-4 space-y-4">
                    <div>
                      <h5 class="text-sm font-medium text-text">Step 1. Bootstrap values</h5>
                      <p class="mt-1 text-xs text-text-dim">
                        Use these values when creating the IAM role in your AWS account.
                        {#if awsPrincipalArn}
                          This principal ARN is your organization broker role.
                        {:else}
                          Your org broker role is not configured yet. Run org provisioning migration first.
                        {/if}
                      </p>
                    </div>

                    <div class="space-y-3">
                      <div>
                        <div class="text-xs text-text-dim">Yaffle principal ARN</div>
                        <div class="mt-1 flex gap-2">
                          <input
                            readonly
                            value={awsBootstrapValues.yafflePrincipalArn}
                            class="w-full rounded-md border border-border bg-surface-raised px-3 py-2 text-text"
                          />
                          <button
                            type="button"
                            class="rounded-md border border-border px-3 py-2 text-xs text-text transition hover:bg-surface-raised"
                            onclick={() => copyAwsValue("principal", awsBootstrapValues.yafflePrincipalArn)}
                          >
                            {copiedAwsField === "principal" ? "Copied" : "Copy"}
                          </button>
                        </div>
                      </div>

                      <div>
                        <div class="text-xs text-text-dim">External ID</div>
                        <div class="mt-1 flex gap-2">
                          <input
                            readonly
                            value={externalIdInput.trim() || awsBootstrapValues.suggestedExternalId}
                            class="w-full rounded-md border border-border bg-surface-raised px-3 py-2 text-text"
                          />
                          <button
                            type="button"
                            class="rounded-md border border-border px-3 py-2 text-xs text-text transition hover:bg-surface-raised"
                            onclick={() => copyAwsValue("external-id", externalIdInput.trim() || awsBootstrapValues.suggestedExternalId)}
                          >
                            {copiedAwsField === "external-id" ? "Copied" : "Copy"}
                          </button>
                        </div>
                      </div>

                      <div>
                        <div class="text-xs text-text-dim">Suggested role name</div>
                        <div class="mt-1 flex gap-2">
                          <input
                            bind:value={awsRoleNameInput}
                            class="w-full rounded-md border border-border bg-surface px-3 py-2 text-text outline-none transition focus:border-border-strong"
                            placeholder={awsBootstrapValues.suggestedRoleName}
                          />
                          <button
                            type="button"
                            class="rounded-md border border-border px-3 py-2 text-xs text-text transition hover:bg-surface-raised"
                            onclick={() => copyAwsValue("role-name", awsRoleNameInput.trim() || awsBootstrapValues.suggestedRoleName)}
                          >
                            {copiedAwsField === "role-name" ? "Copied" : "Copy"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div class="rounded-lg border border-border bg-surface p-4 space-y-4">
                    <div>
                      <h5 class="text-sm font-medium text-text">Step 2. Choose setup method</h5>
                      <p class="mt-1 text-xs text-text-dim">
                        Follow the AWS setup guide for step-by-step instructions for each method,
                        then paste the resulting role ARN in Step 3.
                        <a
                          href="https://yaffle.local:6969/docs/guides/aws/"
                          class="ml-1 text-yaffle-400 underline decoration-dotted hover:text-yaffle-300"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open AWS setup guide
                        </a>
                      </p>
                    </div>

                    <div class="flex flex-wrap gap-2">
                      <button
                        type="button"
                        class={`rounded-md border px-3 py-1.5 text-xs transition ${awsSetupMethod === "terraform"
                          ? "border-border-strong bg-surface-raised text-text"
                          : "border-border text-text-dim hover:bg-surface"}`}
                        onclick={() => awsSetupMethod = "terraform"}
                      >
                        Terraform (Recommended)
                      </button>
                      <button
                        type="button"
                        class={`rounded-md border px-3 py-1.5 text-xs transition ${awsSetupMethod === "cloudformation"
                          ? "border-border-strong bg-surface-raised text-text"
                          : "border-border text-text-dim hover:bg-surface"}`}
                        onclick={() => awsSetupMethod = "cloudformation"}
                      >
                        CloudFormation
                      </button>
                      <button
                        type="button"
                        class={`rounded-md border px-3 py-1.5 text-xs transition ${awsSetupMethod === "cli"
                          ? "border-border-strong bg-surface-raised text-text"
                          : "border-border text-text-dim hover:bg-surface"}`}
                        onclick={() => awsSetupMethod = "cli"}
                      >
                        AWS CLI
                      </button>
                    </div>

                    <div class="relative rounded-md border border-border bg-surface-raised p-3">
                      <div class="absolute right-2 top-2 z-10">
                        <CopyButton copied={copiedAwsSnippet} title="Copy setup snippet" onclick={copyAwsSnippet} />
                      </div>
                      <pre class="overflow-x-auto whitespace-pre-wrap text-xs text-text"><code>{activeAwsSnippet}</code></pre>
                    </div>

                    <p class="text-xs text-text-dim">Use the guide for exact steps and output retrieval.</p>
                  </div>
                {/if}

                <div class="rounded-lg border border-border bg-surface p-4 space-y-3">
                  <div>
                    <h5 class="text-sm font-medium text-text">Step 3. Enter role details</h5>
                    <p class="mt-1 text-xs text-text-dim">
                      {#if isEditing}
                        Role target changes are disabled here to prevent accidental replacement of another AWS connection.
                      {:else}
                        Validation currently checks ARN syntax. Runtime assume-role verification will be added in a follow-up.
                      {/if}
                    </p>
                  </div>

                  <div>
                    <div class="text-text-dim">Role ARN</div>
                    <input
                      bind:value={roleArnInput}
                      readonly={isEditing}
                      class={`mt-1 w-full rounded-md border px-3 py-2 outline-none transition ${isEditing
                        ? "border-border bg-surface-raised text-text-muted"
                        : "border-border bg-surface text-text focus:border-border-strong"}`}
                      placeholder={`arn:aws:iam::123456789012:role/${awsRoleNameInput.trim() || awsBootstrapValues.suggestedRoleName}`}
                    />
                  </div>

                  <div>
                    <div class="text-text-dim">External ID</div>
                    <input
                      bind:value={externalIdInput}
                      readonly={isEditing}
                      class={`mt-1 w-full rounded-md border px-3 py-2 outline-none transition ${isEditing
                        ? "border-border bg-surface-raised text-text-muted"
                        : "border-border bg-surface text-text focus:border-border-strong"}`}
                      placeholder={awsBootstrapValues.suggestedExternalId}
                    />
                  </div>
                </div>
              </div>
            {/if}
          </section>

          <section class="space-y-3 border-t border-border pt-6">
            <h4 class="text-sm font-medium text-text">3. Scope</h4>
            <div class="space-y-5 text-sm">
              <div>
                <div class="text-text-dim">Environments</div>
                <div class="mt-2 flex flex-wrap gap-2">
                  {#each knownEnvironmentOptions as option}
                    <button
                      type="button"
                      disabled={!option.available && !option.selected}
                      class={`rounded-full border px-3 py-1.5 text-xs transition ${option.selected
                        ? option.conflicting
                          ? "border-red-500/60 bg-red-500/10 text-red-300"
                          : "border-border-strong bg-surface-raised text-text"
                        : option.available
                          ? "border-border text-text-dim hover:border-border-strong hover:bg-surface hover:text-text"
                          : "border-border text-text-dim opacity-40"}`}
                      onclick={() => toggleScopeValue("environment", option.value)}
                    >
                      {option.value}
                    </button>
                  {/each}
                </div>
                <div class="mt-3 flex gap-2">
                  <input
                    bind:value={customEnvironmentInput}
                    class="w-full rounded-md border border-border bg-surface px-3 py-2 text-text outline-none transition focus:border-border-strong"
                    placeholder="Add custom environment or pattern (example: production, pr-*)"
                    onkeydown={(event) => handleScopeInputKeydown("environment", event)}
                  />
                  <button
                    type="button"
                    class="rounded-md border border-border px-3 py-2 text-sm text-text transition hover:bg-surface-raised"
                    onclick={() => addCustomScopeValue("environment")}
                  >
                    Add
                  </button>
                </div>
                {#if matchingEnvironmentSuggestions.length > 0}
                  <div class="mt-2 flex flex-wrap gap-2">
                    {#each matchingEnvironmentSuggestions as option, index}
                      <button
                        type="button"
                        class={`rounded-full border px-3 py-1 text-xs transition ${index === envSuggestionIndex
                          ? "border-border-strong bg-surface-raised text-text"
                          : "border-border text-text-dim hover:bg-surface"}`}
                        onclick={() => applyScopeSuggestion("environment", option)}
                        onmouseenter={() => envSuggestionIndex = index}
                      >
                        {option}
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
              <div>
                <div class="text-text-dim">Workspaces</div>
                <div class="mt-2 flex flex-wrap gap-2">
                  {#each knownWorkspaceOptions as option}
                    <button
                      type="button"
                      disabled={!option.available && !option.selected}
                      class={`rounded-full border px-3 py-1.5 text-xs transition ${option.selected
                        ? option.conflicting
                          ? "border-red-500/60 bg-red-500/10 text-red-300"
                          : "border-border-strong bg-surface-raised text-text"
                        : option.available
                          ? "border-border text-text-dim hover:border-border-strong hover:bg-surface hover:text-text"
                          : "border-border text-text-dim opacity-40"}`}
                      onclick={() => toggleScopeValue("workspace", option.value)}
                    >
                      {option.value}
                    </button>
                  {/each}
                </div>
                <div class="mt-3 flex gap-2">
                  <input
                    bind:value={customWorkspaceInput}
                    class="w-full rounded-md border border-border bg-surface px-3 py-2 text-text outline-none transition focus:border-border-strong"
                    placeholder="Add custom workspace or pattern (example: infra/app, infra/*)"
                    onkeydown={(event) => handleScopeInputKeydown("workspace", event)}
                  />
                  <button
                    type="button"
                    class="rounded-md border border-border px-3 py-2 text-sm text-text transition hover:bg-surface-raised"
                    onclick={() => addCustomScopeValue("workspace")}
                  >
                    Add
                  </button>
                </div>
                {#if matchingWorkspaceSuggestions.length > 0}
                  <div class="mt-2 flex flex-wrap gap-2">
                    {#each matchingWorkspaceSuggestions as option, index}
                      <button
                        type="button"
                        class={`rounded-full border px-3 py-1 text-xs transition ${index === workspaceSuggestionIndex
                          ? "border-border-strong bg-surface-raised text-text"
                          : "border-border text-text-dim hover:bg-surface"}`}
                        onclick={() => applyScopeSuggestion("workspace", option)}
                        onmouseenter={() => workspaceSuggestionIndex = index}
                      >
                        {option}
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
            </div>
          </section>

          {#if createError}
            <div class="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {createError}
            </div>
          {/if}

          {#if scopeConflictMessages.length > 0}
            <div class="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {#each scopeConflictMessages as message}
                <div>{message}</div>
              {/each}
            </div>
          {/if}
        </div>

        <div class="border-t border-border bg-surface-raised">
          <div class="mx-auto max-w-5xl flex items-center justify-between gap-3 px-6 py-4">
          <div class="text-sm text-text-dim">
            Runs waiting on this connection should resume automatically after setup.
          </div>

          <div class="flex gap-2">
            <button
              class="rounded-md px-3 py-2 text-sm text-text-muted transition hover:bg-surface"
              onclick={closeCreateModal}
            >
              Cancel
            </button>
            <button
              class="rounded-md border border-border px-3 py-2 text-sm text-text transition hover:bg-surface disabled:opacity-50"
              onclick={submitCreateConnection}
              disabled={creating || scopeConflictMessages.length > 0 || !connectionName.trim() || (selectedConnectionType === "envvar" ? !hasCompleteEnvVarEntries(envVarEntries) : !roleArnInput.trim())}
            >
              {creating ? "Saving..." : isEditing ? "Save changes" : "Save connection"}
            </button>
          </div>
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}
