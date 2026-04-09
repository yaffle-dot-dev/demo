const DRAINING_KNOWN_STATUSES = new Set([
  "DEACTIVATING",
  "STOPPING",
  "DEPROVISIONING",
  "STOPPED",
  "DELETED",
])

function readStatus(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim().toUpperCase()
    }
  }

  return null
}

export function isEcsTaskDrainingOrStopping(payload: Record<string, unknown>): boolean {
  const desiredStatus = readStatus(payload, ["DesiredStatus", "desiredStatus"])
  const knownStatus = readStatus(payload, ["KnownStatus", "knownStatus"])

  if (desiredStatus && desiredStatus !== "RUNNING") {
    return true
  }

  if (knownStatus && DRAINING_KNOWN_STATUSES.has(knownStatus)) {
    return true
  }

  return false
}
