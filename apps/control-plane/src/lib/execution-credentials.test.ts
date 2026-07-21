import { describe, expect, test } from "@yaffle/test"

import type { Connection } from "../db/queries/connections.ts"
import {
  formatConnectionBlockedReason,
  getConnectionReadinessForDeploymentWithDeps,
  resolveExecutionCredentialsForDeploymentWithDeps,
} from "./execution-credentials.ts"

function mockConnection(partial: Partial<Connection>): Connection {
  const now = new Date("2026-01-01T00:00:00Z")
  return {
    id: partial.id ?? "conn-1",
    orgId: partial.orgId ?? "org-1",
    name: partial.name ?? "mock-conn",
    providerType: partial.providerType ?? "aws",
    credentialProviderType: partial.credentialProviderType ?? "iam_role",
    type: partial.type ?? "iam_role",
    config: partial.config ?? {
      providerType: "aws",
      environmentScope: ["production"],
      workspaceScope: ["infra/*"],
    },
    secretStore: partial.secretStore ?? null,
    secretPath: partial.secretPath ?? null,
    secretArn: partial.secretArn ?? "iam-role:arn:aws:iam::123456789012:role/mock",
    lastValidatedAt: partial.lastValidatedAt ?? null,
    lastValidationError: partial.lastValidationError ?? null,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
  }
}

const deployment = {
  orgId: "org-1",
  repo: "repo-a",
  environmentName: "production",
  workspacePath: "infra/app",
  runGroupId: "rg-1",
}

describe("execution credential resolution", () => {
  test("returns missing providers when no connection matches", async () => {
    const result = await resolveExecutionCredentialsForDeploymentWithDeps(deployment, {
      getProvidersForDeployment: async () => ["aws"],
      listConnectionsForOrg: async () => [],
      resolveConnectionEnv: async () => ({ AWS_ACCESS_KEY_ID: "test" }),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.missingProviders).toEqual(["aws"])
      expect(result.conflictProviders).toEqual([])
    }
  })

  test("returns conflict providers when multiple connections match", async () => {
    const result = await resolveExecutionCredentialsForDeploymentWithDeps(deployment, {
      getProvidersForDeployment: async () => ["aws"],
      listConnectionsForOrg: async () => [
        mockConnection({ id: "conn-1", name: "aws-a" }),
        mockConnection({ id: "conn-2", name: "aws-b" }),
      ],
      resolveConnectionEnv: async () => ({ AWS_ACCESS_KEY_ID: "test" }),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.missingProviders).toEqual([])
      expect(result.conflictProviders).toEqual(["aws"])
    }
  })

  test("resolves env vars when exactly one connection matches each provider", async () => {
    const awsConnection = mockConnection({ id: "conn-aws", name: "aws-conn" })
    const cfConnection = mockConnection({
      id: "conn-cf",
      name: "cf-conn",
      providerType: "cloudflare",
      type: "envvar",
      credentialProviderType: "envvar",
      config: {
        providerType: "cloudflare",
        environmentScope: ["production"],
        workspaceScope: ["infra/*"],
      },
    })

    const result = await resolveExecutionCredentialsForDeploymentWithDeps(deployment, {
      getProvidersForDeployment: async () => ["aws", "cloudflare"],
      listConnectionsForOrg: async () => [awsConnection, cfConnection],
      resolveConnectionEnv: async (connection) => {
        if (connection.id === "conn-aws") {
          return { AWS_ACCESS_KEY_ID: "AKIA_TEST" } as Record<string, string>
        }

        return { CLOUDFLARE_API_TOKEN: "cf-token" } as Record<string, string>
      },
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.env).toEqual({
        AWS_ACCESS_KEY_ID: "AKIA_TEST",
        CLOUDFLARE_API_TOKEN: "cf-token",
      })
    }
  })

  test("passes the deployment environment to connection resolution", async () => {
    let resolvedEnvironmentName: string | null = null

    const result = await resolveExecutionCredentialsForDeploymentWithDeps(deployment, {
      getProvidersForDeployment: async () => ["aws"],
      listConnectionsForOrg: async () => [mockConnection({ id: "conn-aws", name: "aws-conn" })],
      resolveConnectionEnv: async (_connection, currentDeployment) => {
        resolvedEnvironmentName = currentDeployment.environmentName
        return { AWS_ACCESS_KEY_ID: "AKIA_TEST" }
      },
    })

    expect(result.ok).toBe(true)
    expect(resolvedEnvironmentName === "production").toBe(true)
  })

  test("returns degraded resolution when provider metadata is unavailable", async () => {
    const result = await resolveExecutionCredentialsForDeploymentWithDeps(deployment, {
      getProvidersForDeployment: async () => {
        throw new Error("The specified key does not exist.")
      },
      listConnectionsForOrg: async () => [],
      resolveConnectionEnv: async () => ({}),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.degradation).toEqual({
        kind: "provider_requirements_unavailable",
        errorKind: "workspace_cache_missing",
        message:
          "Cached workspace archive is missing. Rerun this environment to regenerate provider metadata.",
        retryable: false,
      })
    }
  })
})

describe("connection readiness", () => {
  test("returns not_required when provider discovery is empty", async () => {
    const readiness = await getConnectionReadinessForDeploymentWithDeps(deployment, {
      getProvidersForDeployment: async () => [],
      listConnectionsForOrg: async () => [],
      resolveConnectionEnv: async () => ({}),
    })

    expect(readiness.status).toBe("not_required")
    expect(readiness.requiredProviders).toEqual([])
  })

  test("reports matched, missing, and conflict providers", async () => {
    const readiness = await getConnectionReadinessForDeploymentWithDeps(deployment, {
      getProvidersForDeployment: async () => ["aws", "cloudflare", "tailscale"],
      listConnectionsForOrg: async () => [
        mockConnection({
          id: "aws-1",
          name: "aws",
          providerType: "aws",
        }),
        mockConnection({
          id: "cf-1",
          name: "cf-1",
          providerType: "cloudflare",
          type: "envvar",
          credentialProviderType: "envvar",
          config: {
            providerType: "cloudflare",
            environmentScope: ["production"],
            workspaceScope: ["infra/*"],
          },
        }),
        mockConnection({
          id: "cf-2",
          name: "cf-2",
          providerType: "cloudflare",
          type: "envvar",
          credentialProviderType: "envvar",
          config: {
            providerType: "cloudflare",
            environmentScope: ["production"],
            workspaceScope: ["infra/*"],
          },
        }),
      ],
      resolveConnectionEnv: async () => ({}),
    })

    expect(readiness.status).toBe("conflict")
    expect(readiness.missingProviders).toEqual(["tailscale"])
    expect(readiness.conflictProviders).toEqual(["cloudflare"])
    expect(readiness.matchedConnections).toEqual([
      {
        id: "aws-1",
        name: "aws",
        provider: "aws",
      },
    ])
  })

  test("returns degraded readiness when provider extraction fails", async () => {
    const readiness = await getConnectionReadinessForDeploymentWithDeps(deployment, {
      getProvidersForDeployment: async () => {
        throw new Error("The specified key does not exist.")
      },
      listConnectionsForOrg: async () => [],
      resolveConnectionEnv: async () => ({}),
    })

    expect(readiness.status).toBe("not_required")
    expect(readiness.degradation).toEqual({
      kind: "provider_requirements_unavailable",
      errorKind: "workspace_cache_missing",
      message:
        "Cached workspace archive is missing. Rerun this environment to regenerate provider metadata.",
      retryable: false,
    })
    expect(formatConnectionBlockedReason(readiness)).toBeNull()
  })
})
