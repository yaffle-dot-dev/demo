import type { Env } from "./provider-discovery-agent"
import type {
  DiscoveryDispatchRequest,
  DiscoveryRequestAccepted,
} from "./types"

export interface DiscoveryAgentServer {
  fetch(request: Request): Promise<Response>
}

export type GetDiscoveryAgentByName = (
  namespace: Env["ProviderDiscoveryAgent"],
  name: string,
) => Promise<DiscoveryAgentServer>

export function parseAgentInstanceName(providerType: string): string {
  return providerType
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 80) || "default"
}

export async function dispatchDiscovery(
  env: Env,
  payload: DiscoveryDispatchRequest,
  getAgentByName: GetDiscoveryAgentByName,
): Promise<DiscoveryRequestAccepted> {
  const instanceName = parseAgentInstanceName(payload.providerType)
  const agent = await getAgentByName(env.ProviderDiscoveryAgent, instanceName)

  const response = await agent.fetch(new Request("https://provider-discovery-agent.internal/run", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  }))

  const body = await response.json() as {
    data?: DiscoveryRequestAccepted
    error?: { message?: string }
  }

  if (!response.ok || !body.data) {
    throw new Error(body.error?.message ?? `Agent dispatch failed with status ${response.status}`)
  }

  return body.data
}
