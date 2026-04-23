import type { Hookdeck } from "@hookdeck/sdk"

import type { LiveWebhookLeaseWithDeployment } from "./db/queries/live-webhook-leases.ts"

export const HOOKDECK_LIVE_LEASE_EVENT_ALLOWLIST = [
  "pull_request",
  "push",
  "installation_repositories",
] as const

export interface HookdeckDesiredConnection {
  name: string
  description: string
  sourceId: string
  destinationId: string
  rules: Hookdeck.Rule[]
}

function sanitizeNamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase()
}

function buildScopeHeadersFilter(scope: {
  event: string
}): Record<string, unknown> {
  return {
    "x-github-event": scope.event,
  }
}

function buildScopeBodyFilter(scope: {
  installationId: number
  repositoryId?: number | null
  action?: string | null
  pullRequestNumber?: number | null
  ref?: string | null
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    installation: {
      id: scope.installationId,
    },
  }

  if (scope.repositoryId != null) {
    body.repository = { id: scope.repositoryId }
  }
  if (scope.action != null) {
    body.action = scope.action
  }
  if (scope.pullRequestNumber != null) {
    body.pull_request = { number: scope.pullRequestNumber }
  }
  if (scope.ref != null) {
    body.ref = scope.ref
  }

  return body
}

export function buildHookdeckDestinationName(externalDeploymentId: string): string {
  return `yaffle-routeable-deployment-${sanitizeNamePart(externalDeploymentId)}`
}

export function buildHookdeckPreviewConnectionName(leaseId: string): string {
  return `yaffle-live-lease-${leaseId}`
}

export function buildHookdeckProductionConnectionName(baseName: string, event?: string): string {
  return event ? `${baseName}-${sanitizeNamePart(event)}` : `${baseName}-default`
}

export function buildHookdeckPreviewConnectionRules(lease: Pick<LiveWebhookLeaseWithDeployment, "event" | "installationId" | "repositoryId" | "action" | "pullRequestNumber" | "ref">): Hookdeck.Rule[] {
  return [{
    type: "filter",
    headers: buildScopeHeadersFilter({ event: lease.event }),
    body: buildScopeBodyFilter({
      installationId: lease.installationId,
      repositoryId: lease.repositoryId,
      action: lease.action,
      pullRequestNumber: lease.pullRequestNumber,
      ref: lease.ref,
    }),
  }]
}

export function buildHookdeckProductionCatchAllRules(): Hookdeck.Rule[] {
  return [{
    type: "filter",
    headers: {
      "x-github-event": {
        $nin: [...HOOKDECK_LIVE_LEASE_EVENT_ALLOWLIST],
      },
    },
  }]
}

export function buildHookdeckProductionManagedEventRules(
  event: string,
  leases: Array<Pick<LiveWebhookLeaseWithDeployment, "installationId" | "repositoryId" | "action" | "pullRequestNumber" | "ref">>,
): Hookdeck.Rule[] {
  const bodyFilter = leases.length === 0
    ? undefined
    : {
      $not: leases.length === 1
        ? buildScopeBodyFilter(leases[0])
        : { $or: leases.map((lease) => buildScopeBodyFilter(lease)) },
    }

  return [{
    type: "filter",
    headers: buildScopeHeadersFilter({ event }),
    ...(bodyFilter ? { body: bodyFilter } : {}),
  }]
}

export function buildHookdeckProductionConnections(params: {
  baseConnectionName: string
  sourceId: string
  destinationId: string
  activeLeases: LiveWebhookLeaseWithDeployment[]
}): HookdeckDesiredConnection[] {
  const leasesByEvent = new Map<string, LiveWebhookLeaseWithDeployment[]>()

  for (const lease of params.activeLeases) {
    const leases = leasesByEvent.get(lease.event) ?? []
    leases.push(lease)
    leasesByEvent.set(lease.event, leases)
  }

  const connections: HookdeckDesiredConnection[] = [{
    name: buildHookdeckProductionConnectionName(params.baseConnectionName),
    description: "Production catch-all delivery for unmanaged GitHub events",
    sourceId: params.sourceId,
    destinationId: params.destinationId,
    rules: buildHookdeckProductionCatchAllRules(),
  }]

  for (const event of HOOKDECK_LIVE_LEASE_EVENT_ALLOWLIST) {
    connections.push({
      name: buildHookdeckProductionConnectionName(params.baseConnectionName, event),
      description: `Production delivery for ${event} excluding leased scopes`,
      sourceId: params.sourceId,
      destinationId: params.destinationId,
      rules: buildHookdeckProductionManagedEventRules(event, leasesByEvent.get(event) ?? []),
    })
  }

  return connections
}
