import { parseTrafficControllerComment } from "./lib/traffic-controller-comment"

function requireEnv(name: string): string {
  const value = process.env[name]?.trim() ?? ""
  if (!value) {
    throw new Error(`${name} must be configured`)
  }

  return value
}

const parsed = parseTrafficControllerComment(requireEnv("TRAFFIC_CONTROLLER_COMMENT_BODY"))

console.log(`desired_state=${parsed.desiredState}`)
console.log(`event=${parsed.event}`)
console.log(`action=${parsed.action ?? ""}`)
console.log(`repository_owner=${parsed.repositoryOwner}`)
console.log(`repository_name=${parsed.repositoryName}`)
console.log(`target=${parsed.target === "this_preview" ? "this_preview" : parsed.target.deploymentId}`)
