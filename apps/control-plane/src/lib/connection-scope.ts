import type { Connection } from "../db/queries/connections.ts"

export interface ConnectionScopeConfig {
  providerType: string
  environmentScope: string[]
  workspaceScope: string[]
}

function normalizeScopeList(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return []
  }

  return values.filter((value): value is string => typeof value === "string" && value.length > 0)
}

export function getConnectionScopeConfig(connection: Pick<Connection, "type" | "providerType" | "config">): ConnectionScopeConfig {
  const config = typeof connection.config === "object" && connection.config !== null
    ? connection.config as Record<string, unknown>
    : {}

  const providerType = typeof config.providerType === "string"
    ? config.providerType
    : connection.providerType ?? connection.type

  return {
    providerType: providerType.toLowerCase(),
    environmentScope: normalizeScopeList(config.environmentScope),
    workspaceScope: normalizeScopeList(config.workspaceScope),
  }
}

function matchesPattern(pattern: string, value: string): boolean {
  if (pattern === "*") {
    return true
  }

  if (!pattern.includes("*")) {
    return pattern === value
  }

  const regex = new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`)
  return regex.test(value)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function scopesOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) {
    return true
  }

  for (const left of a) {
    for (const right of b) {
      if (matchesPattern(left, right) || matchesPattern(right, left)) {
        return true
      }
    }
  }

  return false
}

export function connectionScopesOverlap(
  existing: Pick<Connection, "type" | "providerType" | "config">,
  incoming: ConnectionScopeConfig,
): boolean {
  const existingScope = getConnectionScopeConfig(existing)

  if (existingScope.providerType !== incoming.providerType) {
    return false
  }

  return scopesOverlap(existingScope.environmentScope, incoming.environmentScope)
    && scopesOverlap(existingScope.workspaceScope, incoming.workspaceScope)
}
