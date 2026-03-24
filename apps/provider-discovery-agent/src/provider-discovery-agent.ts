import { Agent } from "agents"

import { extractProviderCredentialsWithLlm } from "./provider-llm"
import { discoverProviderCredentials } from "./provider-research"
import { buildSignedCallbackHeaders } from "./signing"
import type {
  DiscoveryDispatchRequest,
  DiscoveryRequestAccepted,
  DiscoveryResultPayload,
} from "./types"
import { discoveryDispatchRequestSchema } from "./types"

export interface ProviderDiscoveryAgentState {
  runs: number
  lastRequestId?: string
  lastProviderType?: string
  lastStatus?: string
  lastError?: string
  lastRunAt?: string
}

export interface Env {
  ProviderDiscoveryAgent: DurableObjectNamespace
  AI: {
    run: (model: string, input: unknown, options?: unknown) => Promise<unknown>
  }
  YAFFLE_PROVIDER_DISCOVERY_AGENT_TOKEN: string
  YAFFLE_PROVIDER_DISCOVERY_CALLBACK_SECRET: string
  YAFFLE_PROVIDER_DISCOVERY_CALLBACK_TIMEOUT_MS?: string
  YAFFLE_PROVIDER_DISCOVERY_MAX_DOCS?: string
  YAFFLE_PROVIDER_DISCOVERY_AI_MODEL?: string
  YAFFLE_PROVIDER_DISCOVERY_AI_GATEWAY_ID?: string
  GITHUB_TOKEN?: string
}

function parseNumberEnv(input: string | undefined, fallback: number): number {
  const parsed = Number(input)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

async function postResultCallback(params: {
  callbackUrl: string
  payload: DiscoveryResultPayload
  callbackSecret: string
  timeoutMs: number
}): Promise<void> {
  const body = JSON.stringify(params.payload)
  const headers = await buildSignedCallbackHeaders({
    body,
    secret: params.callbackSecret,
  })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs)

  try {
    const response = await fetch(params.callbackUrl, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Callback failed with ${response.status}: ${text}`)
    }
  } finally {
    clearTimeout(timeout)
  }
}

export class ProviderDiscoveryAgent extends Agent<Env, ProviderDiscoveryAgentState> {
  initialState: ProviderDiscoveryAgentState = {
    runs: 0,
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== "POST" || !url.pathname.endsWith("/run")) {
      return Response.json(
        { error: { code: "NOT_FOUND", message: "Not found" } },
        { status: 404 },
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return Response.json(
        { error: { code: "BAD_REQUEST", message: "Request body must be valid JSON" } },
        { status: 400 },
      )
    }

    const parsed = discoveryDispatchRequestSchema.safeParse(body)
    if (!parsed.success) {
      return Response.json(
        {
          error: {
            code: "BAD_REQUEST",
            message: "Invalid discovery dispatch payload",
            details: parsed.error.issues,
          },
        },
        { status: 400 },
      )
    }

    try {
      const accepted = await this.executeDiscovery(parsed.data)
      return Response.json({ data: accepted }, { status: 202 })
    } catch (error) {
      return Response.json(
        {
          error: {
            code: "DISCOVERY_RUN_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
        },
        { status: 500 },
      )
    }
  }

  private async executeDiscovery(request: DiscoveryDispatchRequest): Promise<DiscoveryRequestAccepted> {
    const timeoutMs = parseNumberEnv(
      this.env.YAFFLE_PROVIDER_DISCOVERY_CALLBACK_TIMEOUT_MS,
      8000,
    )
    const maxDocs = parseNumberEnv(
      this.env.YAFFLE_PROVIDER_DISCOVERY_MAX_DOCS,
      24,
    )

    this.setState({
      ...this.state,
      runs: this.state.runs + 1,
      lastRequestId: request.requestId,
      lastProviderType: request.providerType,
      lastStatus: "running",
      lastError: undefined,
      lastRunAt: new Date().toISOString(),
    })

    try {
      const result = await discoverProviderCredentials({
        providerType: request.providerType,
        timeoutMs,
        maxDocs,
        githubToken: this.env.GITHUB_TOKEN,
        extractor: (material) => extractProviderCredentialsWithLlm(this.env, material),
      })

      console.log("provider_discovery.callback_flow.succeeded", {
        requestId: request.requestId,
        providerType: request.providerType,
        status: result.status,
        confidence: result.confidence,
        exactEnvVarCount: result.exactEnvVars.length,
        prefixEnvVarCount: result.prefixEnvVars.length,
        sourceCount: result.sources.length,
      })

      await postResultCallback({
        callbackUrl: request.callbackUrl,
        callbackSecret: this.env.YAFFLE_PROVIDER_DISCOVERY_CALLBACK_SECRET,
        timeoutMs,
        payload: {
          requestId: request.requestId,
          status: result.status,
          providerType: request.providerType,
          displayName: result.displayName,
          suggestedCredentialProviderType: "envvar",
          exactEnvVars: result.exactEnvVars,
          prefixEnvVars: result.prefixEnvVars,
          confidence: result.confidence,
          sources: result.sources,
          reasoningSummary: result.reasoningSummary,
        },
      })

      this.setState({
        ...this.state,
        lastRequestId: request.requestId,
        lastProviderType: request.providerType,
        lastStatus: result.status,
        lastError: undefined,
        lastRunAt: new Date().toISOString(),
      })
    } catch (error) {
      console.error("provider_discovery.callback_flow.failed", {
        requestId: request.requestId,
        providerType: request.providerType,
        error: error instanceof Error ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        } : String(error),
      })

      this.setState({
        ...this.state,
        lastRequestId: request.requestId,
        lastProviderType: request.providerType,
        lastStatus: "failed",
        lastError: error instanceof Error ? error.message : String(error),
        lastRunAt: new Date().toISOString(),
      })
      throw error
    }

    return {
      accepted: true,
      requestId: request.requestId,
    }
  }
}
