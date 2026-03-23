import { routeAgentRequest } from "agents"

import { discoverProviderCredentials } from "./provider-research"
import { ProviderDiscoveryAgent, type Env } from "./provider-discovery-agent"
import { timingSafeEqual } from "./signing"
import {
  discoveryDispatchRequestSchema,
  type DiscoveryDispatchRequest,
  type DiscoveryRequestAccepted,
} from "./types"

function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get("authorization")
  if (!auth?.startsWith("Bearer ")) {
    return null
  }

  return auth.slice(7)
}

function parseAgentInstanceName(providerType: string): string {
  return providerType
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 80) || "default"
}

async function dispatchDiscovery(
  env: Env,
  payload: DiscoveryDispatchRequest,
): Promise<DiscoveryRequestAccepted> {
  const instanceName = parseAgentInstanceName(payload.providerType)
  const id = env.ProviderDiscoveryAgent.idFromName(instanceName)
  const stub = env.ProviderDiscoveryAgent.get(id)

  const response = await stub.fetch("https://provider-discovery-agent.internal/run", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  })

  const body = await response.json() as {
    data?: DiscoveryRequestAccepted
    error?: { message?: string }
  }

  if (!response.ok || !body.data) {
    throw new Error(body.error?.message ?? `Agent dispatch failed with status ${response.status}`)
  }

  return body.data
}

function unauthorized(): Response {
  return Response.json(
    { error: { code: "UNAUTHORIZED", message: "Invalid discovery agent token" } },
    { status: 401 },
  )
}

function badRequest(message: string, details?: unknown): Response {
  return Response.json(
    { error: { code: "BAD_REQUEST", message, details } },
    { status: 400 },
  )
}

async function runDirectDiscovery(request: Request, env: Env): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return badRequest("Request body must be valid JSON")
  }

  const parsed = discoveryDispatchRequestSchema.safeParse(body)
  if (!parsed.success) {
    return badRequest("Invalid discovery request payload", parsed.error.issues)
  }

  try {
    const result = await discoverProviderCredentials({
      providerType: parsed.data.providerType,
      timeoutMs: Number(env.YAFFLE_PROVIDER_DISCOVERY_CALLBACK_TIMEOUT_MS ?? "8000"),
      maxDocs: Number(env.YAFFLE_PROVIDER_DISCOVERY_MAX_DOCS ?? "24"),
      githubToken: env.GITHUB_TOKEN,
    })

    return Response.json({ data: result }, { status: 200 })
  } catch (error) {
    return Response.json(
      {
        error: {
          code: "DISCOVERY_DIRECT_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      { status: 500 },
    )
  }
}

export { ProviderDiscoveryAgent }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ data: { ok: true } })
    }

    if (request.method === "POST" && url.pathname === "/discover/direct") {
      const token = extractBearerToken(request)
      const expectedToken = env.YAFFLE_PROVIDER_DISCOVERY_AGENT_TOKEN ?? ""
      if (!token || !expectedToken || !timingSafeEqual(token, expectedToken)) {
        return unauthorized()
      }

      return runDirectDiscovery(request, env)
    }

    const agentResponse = await routeAgentRequest(request, env)
    if (agentResponse) {
      return agentResponse
    }

    if (request.method !== "POST" || (url.pathname !== "/discover" && url.pathname !== "/discover/direct")) {
      return Response.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 })
    }

    const token = extractBearerToken(request)
    const expectedToken = env.YAFFLE_PROVIDER_DISCOVERY_AGENT_TOKEN ?? ""
    if (!token || !expectedToken || !timingSafeEqual(token, expectedToken)) {
      return unauthorized()
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return badRequest("Request body must be valid JSON")
    }

    const parsed = discoveryDispatchRequestSchema.safeParse(body)
    if (!parsed.success) {
      return badRequest("Invalid discovery request payload", parsed.error.issues)
    }

    const callbackSecret = env.YAFFLE_PROVIDER_DISCOVERY_CALLBACK_SECRET
    if (!callbackSecret) {
      return Response.json(
        {
          error: {
            code: "CALLBACK_SECRET_NOT_CONFIGURED",
            message: "YAFFLE_PROVIDER_DISCOVERY_CALLBACK_SECRET is required",
          },
        },
        { status: 503 },
      )
    }

    try {
      const result = await dispatchDiscovery(env, parsed.data)
      return Response.json({ data: result }, { status: 202 })
    } catch (error) {
      return Response.json(
        {
          error: {
            code: "DISCOVERY_DISPATCH_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
        },
        { status: 500 },
      )
    }
  },
}
