export type ParsedRouteCommand = {
  desiredState: "active" | "absent"
  event: "pull_request" | "push" | "installation_repositories"
  action?: string
  repositoryOwner: string
  repositoryName: string
  target: "this_preview" | { deploymentId: string }
}

function parseLegacyCommand(commentBody: string): ParsedRouteCommand | undefined {
  const trimmed = commentBody.trim()
  const match = trimmed.match(/^\/yaffle\s+lease\s+(ensure|revoke)\s+(.+)$/i)
  if (!match) {
    return undefined
  }

  const desiredState = match[1].toLowerCase() === "revoke" ? "absent" : "active"
  const tokens = match[2].trim().split(/\s+/)
  const kv = new Map<string, string>()
  for (const token of tokens) {
    const [key, ...rest] = token.split("=")
    if (!key || rest.length === 0) {
      throw new Error(`Invalid argument '${token}'. Use key=value syntax.`)
    }
    kv.set(key.toLowerCase(), rest.join("="))
  }

  const deploymentId = kv.get("deployment")
  const event = kv.get("event") as ParsedRouteCommand["event"] | undefined
  const repo = kv.get("repo")
  if (!deploymentId || !event || !repo) {
    throw new Error("Legacy command must include deployment=..., event=..., and repo=owner/name")
  }

  const [repositoryOwner, repositoryName] = repo.split("/")
  if (!repositoryOwner || !repositoryName) {
    throw new Error(`Invalid repo '${repo}'. Use owner/name format.`)
  }

  return {
    desiredState,
    event,
    action: kv.get("action") || undefined,
    repositoryOwner,
    repositoryName,
    target: { deploymentId },
  }
}

export function buildDefaultDeploymentId(params: { prNumber: number; actorLogin: string }): string {
  return `dep-pr-${params.prNumber}-${params.actorLogin}`
}

export function parseTrafficControllerComment(commentBody: string): ParsedRouteCommand {
  const legacy = parseLegacyCommand(commentBody)
  if (legacy) {
    return legacy
  }

  const trimmed = commentBody.trim()
  const match = trimmed.match(
    /^\/yaffle\s+(create|destroy)\s+route\s+(pull_request|push|installation_repositories)(?:\s+(\w+))?\s+on\s+([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\s+(?:to|from)\s+(.+)$/i,
  )

  if (!match) {
    throw new Error(
      "Unsupported comment command. Expected '/yaffle create route <event> [action] on owner/repo to this preview' or '/yaffle destroy route ...'.",
    )
  }

  const [, verb, event, action, repositoryOwner, repositoryName, targetRaw] = match
  const normalizedTarget = targetRaw.trim().toLowerCase()

  return {
    desiredState: verb.toLowerCase() === "destroy" ? "absent" : "active",
    event: event.toLowerCase() as ParsedRouteCommand["event"],
    action: action || undefined,
    repositoryOwner,
    repositoryName,
    target: normalizedTarget === "this preview"
      ? "this_preview"
      : { deploymentId: targetRaw.trim() },
  }
}
