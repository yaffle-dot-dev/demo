import { describe, expect, test } from "bun:test"

import type { Connection } from "../db/queries/connections.ts"
import {
  clearWorkspaceProviderCacheForTests,
  connectionMatches,
  findMissingConnectionRequirements,
  type ProviderRequirementDeployment,
} from "./provider-requirements.ts"

function mockConnection(config: Record<string, unknown>): Connection {
  const now = new Date("2026-01-01T00:00:00Z")
  return {
    id: "conn-1",
    orgId: "org-1",
    name: "mock",
    providerType: "aws",
    credentialProviderType: "iam_role",
    type: "iam_role",
    config,
    secretStore: null,
    secretPath: null,
    secretArn: "iam-role:arn:aws:iam::123456789012:role/mock",
    lastValidatedAt: null,
    lastValidationError: null,
    createdAt: now,
    updatedAt: now,
  }
}

function mockDeployment(partial: Partial<ProviderRequirementDeployment>): ProviderRequirementDeployment {
  return {
    orgId: "org-1",
    repo: "repo-a",
    environmentName: "production",
    workspacePath: "infra/app",
    runGroupId: "rg-1",
    ...partial,
  }
}

describe("provider requirements", () => {
  test("matches connection by provider and scope", () => {
    const connection = mockConnection({
      providerType: "aws",
      environmentScope: ["production"],
      workspaceScope: ["infra/*"],
    })

    expect(connectionMatches(connection, "aws", "production", "infra/app")).toBe(true)
    expect(connectionMatches(connection, "aws", "staging", "infra/app")).toBe(false)
    expect(connectionMatches(connection, "cloudflare", "production", "infra/app")).toBe(false)
  })

  test("matches wildcard environment and workspace scopes", () => {
    const connection = mockConnection({
      providerType: "aws",
      environmentScope: ["pr-*"],
      workspaceScope: ["apps/*"],
    })

    expect(connectionMatches(connection, "aws", "pr-7", "apps/runner/infra")).toBe(true)
    expect(connectionMatches(connection, "aws", "main", "apps/runner/infra")).toBe(false)
    expect(connectionMatches(connection, "aws", "pr-7", "infra/shared")).toBe(false)
  })

  test("dedupes provider extraction work per runGroup/workspace pair", async () => {
    clearWorkspaceProviderCacheForTests()

    const deployments = [
      mockDeployment({ environmentName: "production" }),
      mockDeployment({ environmentName: "staging" }),
    ]

    let extractionCalls = 0
    const missing = await findMissingConnectionRequirements(
      {
        deployments,
        connections: [],
      },
      {
        getProvidersForDeployment: async () => {
          extractionCalls += 1
          return ["aws"]
        },
      },
    )

    expect(extractionCalls).toBe(1)
    expect(missing).toHaveLength(2)
    expect(missing[0].provider).toBe("aws")
  })

  test("excludes providers with matching scoped connections", async () => {
    const deployments = [
      mockDeployment({
        environmentName: "production",
        workspacePath: "infra/app",
      }),
      mockDeployment({
        environmentName: "production",
        workspacePath: "infra/other",
      }),
    ]

    const connections: Connection[] = [
      mockConnection({
        providerType: "aws",
        environmentScope: ["production"],
        workspaceScope: ["infra/app"],
      }),
    ]

    const missing = await findMissingConnectionRequirements(
      {
        deployments,
        connections,
      },
      {
        getProvidersForDeployment: async () => ["aws"],
      },
    )

    expect(missing).toHaveLength(1)
    expect(missing[0].workspace).toBe("infra/other")
    expect(missing[0].recommended).toBe("AWS IAM Role")
  })
})
