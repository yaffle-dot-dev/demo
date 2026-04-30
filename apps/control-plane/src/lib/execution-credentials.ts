import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts"

import type { Connection } from "../db/queries/connections.ts"
import type { WorkspaceDeployment } from "../db/queries/workspace-deployments.ts"

import { listConnectionsForOrg } from "../db/queries/connections.ts"
import { findOrgById } from "../db/queries/organizations.ts"
import { getConnectionSecret } from "./connection-secrets.ts"
import { assumeOrgBrokerRole } from "./org-broker-auth.ts"
import {
  connectionMatches,
  getRequiredProviderRequirementsForDeployment,
  getRequiredProvidersForDeployment,
  type ExtractedProviderRequirement,
  type ProviderRequirementDeployment,
} from "./provider-requirements.ts"
import { queueUnknownProviderDiscovery } from "./provider-discovery.ts"
import { logger } from "./telemetry.ts"

export type ExecutionCredentialResolution = {
  ok: true
  env: Record<string, string>
} | {
  ok: false
  missingProviders: string[]
  conflictProviders: string[]
}

export interface ConnectionReadiness {
  status: "ready" | "missing" | "conflict" | "not_required" | "error"
  requiredProviders: string[]
  missingProviders: string[]
  conflictProviders: string[]
  matchedConnections: Array<{
    id: string
    name: string
    provider: string
  }>
  blockedReason?: string | null
}

export function formatConnectionBlockedReason(
  readiness: Pick<ConnectionReadiness, "status" | "missingProviders" | "conflictProviders" | "blockedReason">,
): string | null {
  if (readiness.status === "error") {
    return readiness.blockedReason?.trim() || "Connection readiness unavailable"
  }

  if (readiness.status === "missing") {
    return readiness.missingProviders.length > 0
      ? `Missing connections: ${readiness.missingProviders.join(", ")}`
      : "Missing required connections"
  }

  if (readiness.status === "conflict") {
    return readiness.conflictProviders.length > 0
      ? `Conflicting connections: ${readiness.conflictProviders.join(", ")}`
      : "Conflicting connections"
  }

  return null
}

interface ExecutionResolutionDeps {
  getProvidersForDeployment: (deployment: ProviderRequirementDeployment) => Promise<string[]>
  getProviderRequirementsForDeployment?: (
    deployment: ProviderRequirementDeployment,
  ) => Promise<ExtractedProviderRequirement[]>
  listConnectionsForOrg: (orgId: string) => Promise<Connection[]>
  resolveConnectionEnv: (
    connection: Connection,
    deployment: Pick<WorkspaceDeployment, "environmentName">,
  ) => Promise<Record<string, string>>
}

async function loadProviderRequirements(
  deployment: ProviderRequirementDeployment,
  deps: ExecutionResolutionDeps,
): Promise<ExtractedProviderRequirement[]> {
  if (deps.getProviderRequirementsForDeployment) {
    return deps.getProviderRequirementsForDeployment(deployment)
  }

  const providers = await deps.getProvidersForDeployment(deployment)
  return providers.map((providerType) => ({
    providerType,
    providerSource: null,
  }))
}

async function resolveConnectionEnvForDeployment(
  connection: Connection,
  deployment: Pick<WorkspaceDeployment, "environmentName">,
): Promise<Record<string, string>> {
  const org = await findOrgById(connection.orgId)
  if (!org?.iamRoleArn) {
    throw new Error(`Organization ${connection.orgId} is missing broker role ARN`)
  }

  const brokerCredentials = await assumeOrgBrokerRole(connection.orgId, org.iamRoleArn)

  if (connection.credentialProviderType === "envvar") {
    if (!connection.secretPath) {
      throw new Error(`Connection ${connection.id} is missing secretPath`)
    }

    const secret = await getConnectionSecret(connection.secretPath, {
      credentials: brokerCredentials,
    }) as {
      envVars?: Array<{ key: string; value: string }>
    }

    const env: Record<string, string> = {}
    for (const pair of secret.envVars ?? []) {
      env[pair.key] = pair.value
    }
    return env
  }

  if (connection.credentialProviderType === "iam_role") {
    const config = typeof connection.config === "object" && connection.config !== null
      ? connection.config as Record<string, unknown>
      : {}

    const roleArn = typeof config.roleArn === "string" ? config.roleArn : null
    if (!roleArn) {
      throw new Error(`Connection ${connection.id} is missing roleArn`)
    }

    const brokerSts = new STSClient({
      region: process.env.AWS_REGION ?? "us-east-1",
      credentials: brokerCredentials,
    })

    const assumed = await brokerSts.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `yaffle-run-${connection.id.slice(0, 8)}`,
      ExternalId: typeof config.externalId === "string" ? config.externalId : undefined,
      DurationSeconds: 3600,
      Tags: [
        {
          Key: "environment",
          Value: deployment.environmentName,
        },
      ],
      TransitiveTagKeys: ["environment"],
    }))

    if (!assumed.Credentials?.AccessKeyId || !assumed.Credentials.SecretAccessKey || !assumed.Credentials.SessionToken) {
      throw new Error(`Failed to assume role for connection ${connection.id}`)
    }

    return {
      AWS_ACCESS_KEY_ID: assumed.Credentials.AccessKeyId,
      AWS_SECRET_ACCESS_KEY: assumed.Credentials.SecretAccessKey,
      AWS_SESSION_TOKEN: assumed.Credentials.SessionToken,
      AWS_REGION: process.env.AWS_REGION ?? "us-east-1",
    }
  }

  throw new Error(`Unsupported credential provider type: ${connection.credentialProviderType ?? connection.type}`)
}

export async function resolveExecutionCredentialsForDeployment(
  deployment: Pick<WorkspaceDeployment, "orgId" | "environmentName" | "workspacePath" | "runGroupId"> & ProviderRequirementDeployment,
): Promise<ExecutionCredentialResolution> {
  return resolveExecutionCredentialsForDeploymentWithDeps(deployment, {
    getProvidersForDeployment: getRequiredProvidersForDeployment,
    getProviderRequirementsForDeployment: getRequiredProviderRequirementsForDeployment,
    listConnectionsForOrg,
    resolveConnectionEnv: resolveConnectionEnvForDeployment,
  })
}

export async function resolveExecutionCredentialsForDeploymentWithDeps(
  deployment: Pick<WorkspaceDeployment, "orgId" | "environmentName" | "workspacePath" | "runGroupId"> & ProviderRequirementDeployment,
  deps: ExecutionResolutionDeps,
): Promise<ExecutionCredentialResolution> {
  const [requirements, connections] = await Promise.all([
    loadProviderRequirements(deployment, deps),
    deps.listConnectionsForOrg(deployment.orgId),
  ])

  const missingProviders: string[] = []
  const missingRequirements: ExtractedProviderRequirement[] = []
  const conflictProviders: string[] = []
  const env: Record<string, string> = {}

  for (const requirement of requirements) {
    const provider = requirement.providerType
    const matches = connections.filter((connection) =>
      connectionMatches(connection, provider, deployment.environmentName, deployment.workspacePath)
    )

    if (matches.length === 0) {
      missingProviders.push(provider)
      missingRequirements.push(requirement)
      continue
    }

    if (matches.length > 1) {
      conflictProviders.push(provider)
      continue
    }

    Object.assign(env, await deps.resolveConnectionEnv(matches[0], deployment))
  }

  if (missingProviders.length > 0 || conflictProviders.length > 0) {
    if (missingProviders.length > 0) {
      await queueUnknownProviderDiscovery({
        orgId: deployment.orgId,
        providers: missingRequirements,
        repo: deployment.repo,
        environment: deployment.environmentName,
        workspacePath: deployment.workspacePath,
      }).catch((error) => {
        logger.warn("provider_discovery.queue_failed", {
          orgId: deployment.orgId,
          workspacePath: deployment.workspacePath,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }

    return {
      ok: false,
      missingProviders,
      conflictProviders,
    }
  }

  return {
    ok: true,
    env,
  }
}

export async function getConnectionReadinessForDeployment(
  deployment: Pick<WorkspaceDeployment, "orgId" | "environmentName" | "workspacePath" | "runGroupId"> & ProviderRequirementDeployment,
): Promise<ConnectionReadiness> {
  return getConnectionReadinessForDeploymentWithDeps(deployment, {
    getProvidersForDeployment: getRequiredProvidersForDeployment,
    getProviderRequirementsForDeployment: getRequiredProviderRequirementsForDeployment,
    listConnectionsForOrg,
    resolveConnectionEnv: resolveConnectionEnvForDeployment,
  })
}

export async function getConnectionReadinessForDeploymentWithDeps(
  deployment: Pick<WorkspaceDeployment, "orgId" | "environmentName" | "workspacePath" | "runGroupId"> & ProviderRequirementDeployment,
  deps: ExecutionResolutionDeps,
): Promise<ConnectionReadiness> {
  const connectionsPromise = deps.listConnectionsForOrg(deployment.orgId)

  let requirements: ExtractedProviderRequirement[]
  try {
    requirements = await loadProviderRequirements(deployment, deps)
  } catch (error) {
    logger.error("connection_readiness.provider_extraction_failed", {
      error: error instanceof Error ? error.message : String(error),
      orgId: deployment.orgId,
      repo: deployment.repo,
      environment: deployment.environmentName,
      workspacePath: deployment.workspacePath,
      runGroupId: deployment.runGroupId ?? undefined,
    })

    return {
      status: "error",
      requiredProviders: [],
      missingProviders: [],
      conflictProviders: [],
      matchedConnections: [],
      blockedReason: "Connection readiness unavailable for this workspace",
    }
  }

  const connections = await connectionsPromise

  const providers = requirements.map((requirement) => requirement.providerType)

  if (providers.length === 0) {
    return {
      status: "not_required",
      requiredProviders: [],
      missingProviders: [],
      conflictProviders: [],
      matchedConnections: [],
      blockedReason: null,
    }
  }

  const missingProviders: string[] = []
  const missingRequirements: ExtractedProviderRequirement[] = []
  const conflictProviders: string[] = []
  const matchedConnections: Array<{ id: string; name: string; provider: string }> = []

  for (const requirement of requirements) {
    const provider = requirement.providerType
    const matches = connections.filter((connection) =>
      connectionMatches(connection, provider, deployment.environmentName, deployment.workspacePath)
    )

    if (matches.length === 0) {
      missingProviders.push(provider)
      missingRequirements.push(requirement)
    } else if (matches.length > 1) {
      conflictProviders.push(provider)
    } else {
      matchedConnections.push({
        id: matches[0].id,
        name: matches[0].name,
        provider,
      })
    }
  }

  if (missingProviders.length > 0) {
    await queueUnknownProviderDiscovery({
      orgId: deployment.orgId,
      providers: missingRequirements,
      repo: deployment.repo,
      environment: deployment.environmentName,
      workspacePath: deployment.workspacePath,
    }).catch((error) => {
      logger.warn("provider_discovery.queue_failed", {
        orgId: deployment.orgId,
        workspacePath: deployment.workspacePath,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  return {
    status: conflictProviders.length > 0
      ? "conflict"
      : missingProviders.length > 0
        ? "missing"
        : "ready",
    requiredProviders: providers,
    missingProviders,
    conflictProviders,
    matchedConnections,
    blockedReason: null,
  }
}
