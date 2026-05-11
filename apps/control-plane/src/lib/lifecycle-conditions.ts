export type LifecycleConditionName =
  | "infra_ready"
  | "activation_settled"
  | "verification_settled"
  | "usable"
  | "acceptable"

export type LifecycleConditionSummary =
  | "idle"
  | "progressing"
  | "succeeded"
  | "degraded"
  | "blocked"
  | "failed"
  | "mixed"

export interface LifecycleConditionVector {
  pending: number
  running: number
  succeeded: number
  degraded: number
  blocked: number
  failed: number
}

export interface LifecycleCondition {
  name: LifecycleConditionName
  met: boolean
  summary: LifecycleConditionSummary
  vector: LifecycleConditionVector
}

export interface LifecycleConditionItem {
  workspacePath?: string
  phase: string
  state: string
  scopes: string[]
}

export interface WorkspaceLifecycleState {
  conditions: Record<LifecycleConditionName, LifecycleCondition>
  deploymentStatus: "activating" | "ready" | "failed"
}

export interface RunGroupLifecycleState {
  status: "running" | "success" | "partial" | "failed"
  isComplete: boolean
}

const EMPTY_VECTOR: LifecycleConditionVector = {
  pending: 0,
  running: 0,
  succeeded: 0,
  degraded: 0,
  blocked: 0,
  failed: 0,
}

export function deriveLifecycleConditions(
  items: LifecycleConditionItem[],
): Record<LifecycleConditionName, LifecycleCondition> {
  return {
    infra_ready: deriveLifecycleCondition("infra_ready", items),
    activation_settled: deriveLifecycleCondition("activation_settled", items),
    verification_settled: deriveLifecycleCondition("verification_settled", items),
    usable: deriveLifecycleCondition("usable", items),
    acceptable: deriveLifecycleCondition("acceptable", items),
  }
}

export function deriveWorkspaceLifecycleState(items: LifecycleConditionItem[]): WorkspaceLifecycleState {
  const conditions = deriveLifecycleConditions(items)
  const usable = conditions.usable

  if (usable.vector.failed > 0 || usable.vector.blocked > 0) {
    return {
      conditions,
      deploymentStatus: "failed",
    }
  }

  if (usable.met) {
    return {
      conditions,
      deploymentStatus: "ready",
    }
  }

  return {
    conditions,
    deploymentStatus: "activating",
  }
}

export function deriveRunGroupLifecycleState(params: {
  deployments: Array<{ workspacePath: string; status: string }>
  items: LifecycleConditionItem[]
}): RunGroupLifecycleState {
  let hasPartial = false

  for (const deployment of params.deployments) {
    if (["failed", "system_error"].includes(deployment.status)) {
      return { status: "failed", isComplete: true }
    }

    if (["pending", "planning", "awaiting_apply", "applying", "awaiting_approval", "activating", "destroying"].includes(deployment.status)) {
      return { status: "running", isComplete: false }
    }

    if (deployment.status === "destroyed") {
      continue
    }

    const workspaceState = deriveWorkspaceLifecycleState(
      params.items.filter((item) => item.workspacePath === deployment.workspacePath),
    )

    if (workspaceState.deploymentStatus === "failed") {
      return { status: "failed", isComplete: true }
    }

    if (workspaceState.deploymentStatus === "activating") {
      return { status: "running", isComplete: false }
    }

    const acceptable = workspaceState.conditions.acceptable
    if (acceptable.vector.failed > 0 || acceptable.vector.blocked > 0) {
      return { status: "failed", isComplete: true }
    }

    if (!acceptable.met) {
      if (acceptable.vector.pending > 0 || acceptable.vector.running > 0) {
        return { status: "running", isComplete: false }
      }

      hasPartial = true
    }
  }

  return hasPartial
    ? { status: "partial", isComplete: true }
    : { status: "success", isComplete: true }
}

function deriveLifecycleCondition(
  name: LifecycleConditionName,
  items: LifecycleConditionItem[],
): LifecycleCondition {
  const vector = buildLifecycleVector(filterLifecycleItems(name, items))

  return {
    name,
    met: lifecycleConditionMet(name, vector),
    summary: lifecycleConditionSummary(vector),
    vector,
  }
}

function filterLifecycleItems(
  name: LifecycleConditionName,
  items: LifecycleConditionItem[],
): LifecycleConditionItem[] {
  switch (name) {
    case "infra_ready":
      return items.filter((item) => item.scopes.includes("infra_dag"))
    case "activation_settled":
      return items.filter((item) => item.phase === "activation")
    case "verification_settled":
      return items.filter((item) => item.phase === "verification")
    case "usable":
      return items.filter((item) => item.scopes.includes("usable"))
    case "acceptable":
      return items.filter((item) => item.scopes.includes("acceptable"))
  }
}

function buildLifecycleVector(items: LifecycleConditionItem[]): LifecycleConditionVector {
  const vector = { ...EMPTY_VECTOR }

  for (const item of items) {
    switch (item.state) {
      case "pending":
      case "running":
      case "succeeded":
      case "degraded":
      case "blocked":
      case "failed":
        vector[item.state] += 1
        break
      default:
        break
    }
  }

  return vector
}

function lifecycleConditionMet(
  name: LifecycleConditionName,
  vector: LifecycleConditionVector,
): boolean {
  switch (name) {
    case "infra_ready":
      return vector.pending === 0
        && vector.running === 0
        && vector.degraded === 0
        && vector.blocked === 0
        && vector.failed === 0
    case "activation_settled":
    case "verification_settled":
      return vector.pending === 0 && vector.running === 0
    case "usable":
      return vector.pending === 0
        && vector.running === 0
        && vector.blocked === 0
        && vector.failed === 0
    case "acceptable":
      return vector.pending === 0
        && vector.running === 0
        && vector.degraded === 0
        && vector.blocked === 0
        && vector.failed === 0
  }
}

function lifecycleConditionSummary(vector: LifecycleConditionVector): LifecycleConditionSummary {
  const total = Object.values(vector).reduce((sum, count) => sum + count, 0)
  if (total === 0) {
    return "idle"
  }

  const nonZeroBuckets = Object.entries(vector).filter(([, count]) => count > 0)
  if (nonZeroBuckets.length === 1) {
    switch (nonZeroBuckets[0][0]) {
      case "pending":
      case "running":
        return "progressing"
      case "succeeded":
        return "succeeded"
      case "degraded":
        return "degraded"
      case "blocked":
        return "blocked"
      case "failed":
        return "failed"
      default:
        return "mixed"
    }
  }

  return "mixed"
}
