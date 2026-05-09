import { describe, expect, test } from "@yaffle/test"

import { dispatchDiscovery, parseAgentInstanceName } from "./discovery-dispatch"
import type { DiscoveryDispatchRequest } from "./types"

const payload: DiscoveryDispatchRequest = {
  requestId: "req-123",
  providerType: "hashicorp/tfe",
  repo: "yaffle-dot-dev/yaffle",
  environment: "main",
  workspacePath: "infra/shared",
  callbackUrl: "https://api.yaffle.dev/api/internal/provider-discovery/results",
  callbackAuth: {
    mode: "hmac-sha256",
    secretRef: "YAFFLE_PROVIDER_DISCOVERY_CALLBACK_SECRET",
  },
  callbackTtlSeconds: 600,
}

describe("parseAgentInstanceName", () => {
  test("normalizes provider type into a stable agent name", () => {
    expect(parseAgentInstanceName(" hashicorp/tfe ")).toBe("hashicorp-tfe")
  })
})

describe("dispatchDiscovery", () => {
  test("routes discovery through getAgentByName and agent.fetch", async () => {
    let requestedName = ""
    let capturedRequest: Request | null = null

    const result = await dispatchDiscovery(
      {
        ProviderDiscoveryAgent: {} as DurableObjectNamespace,
      } as never,
      payload,
      async (_namespace, name) => {
        requestedName = name
        return {
          fetch: async (request) => {
            capturedRequest = request
            return Response.json({
              data: {
                accepted: true,
                requestId: payload.requestId,
              },
            }, { status: 202 })
          },
        }
      },
    )

    if (!capturedRequest) {
      throw new Error("expected request to be forwarded to the agent")
    }

    const forwardedRequest = capturedRequest as Request
    const forwardedPayload = await forwardedRequest.json() as DiscoveryDispatchRequest

    expect(requestedName).toBe("hashicorp-tfe")
    expect(forwardedRequest.url).toBe("https://provider-discovery-agent.internal/run")
    expect(forwardedRequest.method).toBe("POST")
    expect(forwardedRequest.headers.get("content-type")).toBe("application/json")
    expect(forwardedPayload).toEqual(payload)
    expect(result).toEqual({
      accepted: true,
      requestId: payload.requestId,
    })
  })
})
