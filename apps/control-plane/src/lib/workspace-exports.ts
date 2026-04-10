import type { Workspace as TfcWorkspace } from "../db/queries/workspaces.ts"

import {
  matchConsumerSelector,
  type Workspace as ConfigWorkspace,
  type YaffleTomlConfig,
} from "./config-toml.ts"

export interface ModuleConsumerWorkspace {
  orgId: string
  orgSlug: string
  repo: string
  workspacePath: string
}

export interface ModuleAccessDecision {
  allowed: boolean
  allowedOutputs: string[] | null
  errorStatus?: number
  errorTitle?: string
  errorDetail?: string
}

export type ProducerConfigState = "loaded" | "missing" | "unavailable"

interface TerraformOutput {
  value: unknown
  type?: unknown
  sensitive?: boolean
}

function normalizeRepoName(repo: string): string {
  return repo.trim().toLowerCase()
}

function repoBasename(repo: string): string {
  const parts = normalizeRepoName(repo).split("/")
  return parts[parts.length - 1] ?? normalizeRepoName(repo)
}

function isSameRepoConsumer(
  producerWorkspace: TfcWorkspace,
  consumerWorkspace: ModuleConsumerWorkspace,
): boolean {
  if (producerWorkspace.orgId !== consumerWorkspace.orgId) {
    return false
  }

  const producerRepo = normalizeRepoName(producerWorkspace.repo)
  const consumerRepo = normalizeRepoName(consumerWorkspace.repo)

  return producerRepo === consumerRepo || repoBasename(producerRepo) === repoBasename(consumerRepo)
}

function getWorkspaceConfig(
  config: YaffleTomlConfig | null,
  workspacePath: string,
): ConfigWorkspace | undefined {
  return config?.workspaces.find((workspace) => workspace.path === workspacePath)
}

export function resolveModuleAccessDecision(params: {
  authType: "user" | "run"
  producerWorkspace: TfcWorkspace
  producerConfigState: ProducerConfigState
  producerConfig: YaffleTomlConfig | null
  consumerWorkspace: ModuleConsumerWorkspace | null
}): ModuleAccessDecision {
  const workspaceConfig = getWorkspaceConfig(params.producerConfig, params.producerWorkspace.workspacePath)
  const outputPolicies = workspaceConfig?.outputs ?? {}
  const hasExplicitOutputPolicies = Object.keys(outputPolicies).length > 0

  if (!params.consumerWorkspace) {
    if (params.authType === "run") {
      return {
        allowed: false,
        errorStatus: 403,
        errorTitle: "Consumer workspace not found",
        errorDetail: "This run token is missing a valid consumer workspace context for module authorization.",
        allowedOutputs: null,
      }
    }

    if (params.producerConfigState === "unavailable") {
      return {
        allowed: false,
        errorStatus: 503,
        errorTitle: "Producer config unavailable",
        errorDetail: "Yaffle could not load the producer workspace configuration needed for module authorization.",
        allowedOutputs: null,
      }
    }

    if (!hasExplicitOutputPolicies) {
      return {
        allowed: true,
        allowedOutputs: null,
      }
    }

    return {
      allowed: false,
      errorStatus: 403,
      errorTitle: "Workspace-scoped token required",
      errorDetail: "This module defines output access policies. Use a Yaffle run token so the consumer workspace can be authorized.",
      allowedOutputs: null,
    }
  }

  if (isSameRepoConsumer(params.producerWorkspace, params.consumerWorkspace)) {
    return {
      allowed: true,
      allowedOutputs: null,
    }
  }

  if (params.producerConfigState === "unavailable") {
    return {
      allowed: false,
      errorStatus: 503,
      errorTitle: "Producer config unavailable",
      errorDetail: "Yaffle could not load the producer workspace configuration needed to verify public outputs.",
      allowedOutputs: null,
    }
  }

  if (!hasExplicitOutputPolicies) {
    return {
      allowed: false,
      errorStatus: 403,
      errorTitle: "Module not exported to this workspace",
      errorDetail: "This workspace has no public outputs configured. External access requires explicit output policies in yaffle.toml.",
      allowedOutputs: null,
    }
  }

  const allowedOutputs = new Set<string>()
  for (const [outputName, policy] of Object.entries(outputPolicies)) {
    if (policy.visibility !== "public") {
      continue
    }

    const isMatch = (policy.consumers ?? []).some((selector) =>
      matchConsumerSelector(selector, {
        org: params.consumerWorkspace!.orgSlug,
        repo: normalizeRepoName(params.consumerWorkspace!.repo),
        workspacePath: params.consumerWorkspace!.workspacePath,
      })
    )

    if (!isMatch) {
      continue
    }

    allowedOutputs.add(outputName)
  }

  if (allowedOutputs.size === 0) {
    return {
      allowed: false,
      errorStatus: 403,
      errorTitle: "Module not exported to this workspace",
      errorDetail: "The producer workspace has not allowlisted this consumer workspace for any public outputs.",
      allowedOutputs: null,
    }
  }

  return {
    allowed: true,
    allowedOutputs: Array.from(allowedOutputs).sort(),
  }
}

export function filterOutputsForAccess(
  outputs: Record<string, unknown> | null,
  allowedOutputs: string[] | null,
): Record<string, unknown> | null {
  if (!outputs || !allowedOutputs) {
    return outputs
  }

  const allowedOutputSet = new Set(allowedOutputs)
  const filteredEntries = Object.entries(outputs).filter(([name]) => allowedOutputSet.has(name))
  return Object.fromEntries(filteredEntries)
}

export function findSensitiveExportedOutputs(
  outputs: Record<string, unknown> | null,
  allowedOutputs: string[] | null,
): string[] {
  if (!outputs || !allowedOutputs) {
    return []
  }

  const allowedOutputSet = new Set(allowedOutputs)

  return Object.entries(outputs)
    .filter(([name]) => allowedOutputSet.has(name))
    .flatMap(([name, output]) => {
      if (!output || typeof output !== "object") {
        return []
      }

      return (output as TerraformOutput).sensitive ? [name] : []
    })
    .sort()
}
