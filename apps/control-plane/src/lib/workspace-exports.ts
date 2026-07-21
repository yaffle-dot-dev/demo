import type { Workspace as TfcWorkspace } from "../db/queries/workspaces.ts"

import {
  matchConsumerSelector,
  type Workspace as ConfigWorkspace,
  type YaffleTomlConfig,
} from "./config-toml.ts"
import { selectTerraformOutputs } from "./output-selection.ts"

export interface ModuleConsumerWorkspace {
  orgId: string
  orgSlug: string
  repo: string
  workspacePath: string
  environmentKind: "named" | "transient"
  environmentName: string
}

export interface ModuleAccessDecision {
  allowed: boolean
  allowedOutputs: string[] | null
  errorStatus?: number
  errorTitle?: string
  errorDetail?: string
}

export type ProducerConfigState = "loaded" | "missing" | "unavailable"

function normalizeRepoName(repo: string): string {
  return repo.trim().toLowerCase()
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

  return producerRepo === consumerRepo
}

function isProducerWorkspace(
  producerWorkspace: TfcWorkspace,
  consumerWorkspace: ModuleConsumerWorkspace,
): boolean {
  return (
    isSameRepoConsumer(producerWorkspace, consumerWorkspace) &&
    producerWorkspace.workspacePath === consumerWorkspace.workspacePath &&
    producerWorkspace.environmentKind === consumerWorkspace.environmentKind &&
    producerWorkspace.environmentName === consumerWorkspace.environmentName
  )
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
  const workspaceConfig = getWorkspaceConfig(
    params.producerConfig,
    params.producerWorkspace.workspacePath,
  )
  const outputPolicies = workspaceConfig?.outputs ?? {}
  const hasExplicitOutputPolicies = Object.keys(outputPolicies).length > 0

  if (!params.consumerWorkspace) {
    if (params.authType === "run") {
      return {
        allowed: false,
        errorStatus: 403,
        errorTitle: "Consumer workspace not found",
        errorDetail:
          "This run token is missing a valid consumer workspace context for module authorization.",
        allowedOutputs: null,
      }
    }

    if (params.producerConfigState === "unavailable") {
      return {
        allowed: false,
        errorStatus: 503,
        errorTitle: "Producer config unavailable",
        errorDetail:
          "Yaffle could not load the producer workspace configuration needed for module authorization.",
        allowedOutputs: null,
      }
    }

    return {
      allowed: false,
      errorStatus: 403,
      errorTitle: "Workspace-scoped token required",
      errorDetail:
        "Use a Yaffle run token so the consumer workspace and selected outputs can be authorized.",
      allowedOutputs: null,
    }
  }

  if (params.producerWorkspace.orgId !== params.consumerWorkspace.orgId) {
    return {
      allowed: false,
      errorStatus: 403,
      errorTitle: "Cross-organization output sharing is unavailable",
      errorDetail: "Beta output consumers must belong to the producer's Yaffle organization.",
      allowedOutputs: null,
    }
  }

  if (isProducerWorkspace(params.producerWorkspace, params.consumerWorkspace)) {
    return { allowed: true, allowedOutputs: null }
  }

  if (isSameRepoConsumer(params.producerWorkspace, params.consumerWorkspace)) {
    const allowedOutputs = Object.keys(outputPolicies).sort()
    if (allowedOutputs.length === 0) {
      return {
        allowed: false,
        errorStatus: 403,
        errorTitle: "Module outputs are not selected",
        errorDetail:
          "The producer workspace must explicitly select outputs in yaffle.toml before another workspace can consume them.",
        allowedOutputs: null,
      }
    }
    return {
      allowed: true,
      allowedOutputs,
    }
  }

  if (params.producerConfigState === "unavailable") {
    return {
      allowed: false,
      errorStatus: 503,
      errorTitle: "Producer config unavailable",
      errorDetail:
        "Yaffle could not load the producer workspace configuration needed to verify public outputs.",
      allowedOutputs: null,
    }
  }

  if (!hasExplicitOutputPolicies) {
    return {
      allowed: false,
      errorStatus: 403,
      errorTitle: "Module not exported to this workspace",
      errorDetail:
        "This workspace has no public outputs configured. External access requires explicit output policies in yaffle.toml.",
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
      }),
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
      errorDetail:
        "The producer workspace has not allowlisted this consumer workspace for any public outputs.",
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
  return selectTerraformOutputs({
    outputs,
    selection: allowedOutputs ? { kind: "names", names: allowedOutputs } : { kind: "all" },
    sensitive: "preserve",
  })
}

export function findSensitiveExportedOutputs(
  outputs: Record<string, unknown> | null,
  allowedOutputs: string[] | null,
): string[] {
  if (!outputs) {
    return []
  }

  const selected = selectTerraformOutputs({
    outputs,
    selection: allowedOutputs ? { kind: "names", names: allowedOutputs } : { kind: "all" },
    sensitive: "preserve",
  })

  return Object.entries(selected ?? {})
    .filter(([, output]) => output.sensitive === true)
    .map(([name]) => name)
    .sort()
}
