import { describe, expect, test } from "bun:test"

import type { OrgConnection } from "./api"
import {
  buildConnectionScopeValidation,
  type ConnectionScopeValidationInput,
  type ProviderCredentialSignatureSummary,
} from "./connection-scope-validation"

const providerSignatures: ProviderCredentialSignatureSummary[] = [
  {
    providerType: "aws",
    displayName: "AWS",
    suggestedCredentialProviderType: "iam_role",
    exactEnvVars: [],
    prefixEnvVars: [],
  },
  {
    providerType: "hookdeck",
    displayName: "Hookdeck",
    suggestedCredentialProviderType: "envvar",
    exactEnvVars: ["HOOKDECK_API_KEY"],
    prefixEnvVars: [],
  },
]

function mockConnection(config: Record<string, unknown>, overrides: Partial<OrgConnection> = {}): OrgConnection {
  return {
    id: overrides.id ?? "connection-id",
    name: overrides.name ?? "Connection",
    type: overrides.type ?? "iam_role",
    providerType: overrides.providerType ?? (typeof config.providerType === "string" ? config.providerType : null),
    credentialProviderType: overrides.credentialProviderType
      ?? (typeof config.credentialProviderType === "string" ? config.credentialProviderType : null),
    config,
    secretStore: null,
    secretPath: null,
    secretArn: overrides.secretArn ?? "secret",
    lastValidatedAt: null,
    lastValidationError: null,
    createdAt: "2026-04-30T00:00:00.000Z",
    updatedAt: "2026-04-30T00:00:00.000Z",
  }
}

function baseInput(overrides: Partial<ConnectionScopeValidationInput> = {}): ConnectionScopeValidationInput {
  return {
    connections: [],
    providerSignatures,
    missingRequirements: [],
    editingConnectionId: null,
    selectedConnectionType: "envvar",
    selectedEnvironments: [],
    selectedWorkspaces: [],
    envVarEntries: [{ key: "", value: "" }],
    suggestedEnvironments: [],
    suggestedWorkspaces: [],
    ...overrides,
  }
}

describe("connection-scope-validation", () => {
  test("shows known scopes from existing connections and current selections", () => {
    const result = buildConnectionScopeValidation(baseInput({
      connections: [
        mockConnection({
          providerType: "aws",
          credentialProviderType: "iam_role",
          environmentScope: ["main"],
          workspaceScope: ["apps/web/infra"],
        }),
      ],
      selectedEnvironments: ["pr-*"],
      selectedWorkspaces: ["infra/*"],
      suggestedEnvironments: ["staging"],
      suggestedWorkspaces: ["apps/control-plane/infra"],
    }))

    expect(result.environmentOptions.map((option) => option.value)).toEqual([
      "main",
      "pr-*",
      "staging",
    ])
    expect(result.workspaceOptions.map((option) => option.value)).toEqual([
      "apps/control-plane/infra",
      "apps/web/infra",
      "infra/*",
    ])
  })

  test("disables conflicting workspace options for iam role drafts", () => {
    const result = buildConnectionScopeValidation(baseInput({
      connections: [
        mockConnection({
          providerType: "aws",
          credentialProviderType: "iam_role",
          environmentScope: ["main"],
          workspaceScope: ["apps/infra"],
        }, {
          id: "main-aws",
        }),
      ],
      selectedConnectionType: "iam-role",
      selectedEnvironments: ["main"],
      suggestedWorkspaces: ["apps/infra", "apps/web/infra"],
    }))

    const infraWorkspace = result.workspaceOptions.find((option) => option.value === "apps/infra")
    const webWorkspace = result.workspaceOptions.find((option) => option.value === "apps/web/infra")

    expect(infraWorkspace?.available).toBe(false)
    expect(webWorkspace?.available).toBe(true)
  })

  test("validates selected scopes after env var keys are added", () => {
    const result = buildConnectionScopeValidation(baseInput({
      connections: [
        mockConnection({
          providerType: "hookdeck",
          credentialProviderType: "envvar",
          environmentScope: ["main"],
          workspaceScope: ["apps/infra"],
          envVarKeys: ["HOOKDECK_API_KEY"],
        }, {
          id: "hookdeck-main",
          type: "envvar",
          providerType: "hookdeck",
          credentialProviderType: "envvar",
        }),
      ],
      selectedConnectionType: "envvar",
      selectedEnvironments: ["main"],
      selectedWorkspaces: ["apps/infra"],
      envVarEntries: [{ key: "HOOKDECK_API_KEY", value: "secret" }],
    }))

    expect(result.conflictMessages).toEqual([
      "HOOKDECK_API_KEY is already defined for apps/infra in main.",
      "Hookdeck credentials are already defined for apps/infra in main.",
    ])
  })

  test("allows selecting scopes before credential fields are known", () => {
    const result = buildConnectionScopeValidation(baseInput({
      connections: [
        mockConnection({
          providerType: "hookdeck",
          credentialProviderType: "envvar",
          environmentScope: ["main"],
          workspaceScope: ["apps/infra"],
          envVarKeys: ["HOOKDECK_API_KEY"],
        }, {
          id: "hookdeck-main",
          type: "envvar",
          providerType: "hookdeck",
          credentialProviderType: "envvar",
        }),
      ],
      selectedConnectionType: "envvar",
      selectedEnvironments: ["main"],
      selectedWorkspaces: ["apps/infra"],
      envVarEntries: [{ key: "", value: "" }],
    }))

    expect(result.conflictMessages).toEqual([])
    expect(result.environmentOptions.find((option) => option.value === "main")?.conflicting).toBe(false)
    expect(result.workspaceOptions.find((option) => option.value === "apps/infra")?.conflicting).toBe(false)
  })

  test("ignores the connection being edited when checking conflicts", () => {
    const result = buildConnectionScopeValidation(baseInput({
      connections: [
        mockConnection({
          providerType: "hookdeck",
          credentialProviderType: "envvar",
          environmentScope: ["main"],
          workspaceScope: ["apps/infra"],
          envVarKeys: ["HOOKDECK_API_KEY"],
        }, {
          id: "hookdeck-main",
          type: "envvar",
          providerType: "hookdeck",
          credentialProviderType: "envvar",
        }),
      ],
      editingConnectionId: "hookdeck-main",
      selectedConnectionType: "envvar",
      selectedEnvironments: ["main"],
      selectedWorkspaces: ["apps/infra"],
      envVarEntries: [{ key: "HOOKDECK_API_KEY", value: "secret" }],
    }))

    expect(result.conflictMessages).toEqual([])
    expect(result.workspaceOptions.find((option) => option.value === "apps/infra")?.conflicting).toBe(false)
  })
})
