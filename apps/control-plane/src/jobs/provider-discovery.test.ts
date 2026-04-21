import { afterEach, describe, expect, test } from "bun:test"

import { handleProviderDiscoveryJob, resolveProviderDiscoveryCallbackUrl } from "./provider-discovery.ts"

const originalPublicApiUrl = process.env.YAFFLE_PUBLIC_API_URL
const originalBetterAuthUrl = process.env.BETTER_AUTH_URL
const originalDiscoveryEnabled = process.env.YAFFLE_PROVIDER_DISCOVERY_ENABLED
const originalDiscoveryEndpoint = process.env.YAFFLE_PROVIDER_DISCOVERY_AGENT_ENDPOINT
const originalDiscoveryToken = process.env.YAFFLE_PROVIDER_DISCOVERY_AGENT_TOKEN
const originalCallbackSecret = process.env.YAFFLE_PROVIDER_DISCOVERY_CALLBACK_SECRET

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
    return
  }

  process.env[name] = value
}

const baseJob = {
  id: crypto.randomUUID(),
  orgId: crypto.randomUUID(),
  jobType: "provider_discovery",
  status: "pending",
  payload: {
    providerType: "hookdeck",
    repo: "yaffle-dot-dev/yaffle",
    environment: "main",
    workspacePath: "infra/shared",
    requestedByOrgId: crypto.randomUUID(),
  },
  runAt: new Date(),
  attempts: 0,
  lastError: null,
  startedAt: null,
  completedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

afterEach(() => {
  restoreEnv("YAFFLE_PUBLIC_API_URL", originalPublicApiUrl)
  restoreEnv("BETTER_AUTH_URL", originalBetterAuthUrl)
  restoreEnv("YAFFLE_PROVIDER_DISCOVERY_ENABLED", originalDiscoveryEnabled)
  restoreEnv("YAFFLE_PROVIDER_DISCOVERY_AGENT_ENDPOINT", originalDiscoveryEndpoint)
  restoreEnv("YAFFLE_PROVIDER_DISCOVERY_AGENT_TOKEN", originalDiscoveryToken)
  restoreEnv("YAFFLE_PROVIDER_DISCOVERY_CALLBACK_SECRET", originalCallbackSecret)
})

describe("resolveProviderDiscoveryCallbackUrl", () => {
  test("derives callback url from public api url", () => {
    process.env.YAFFLE_PUBLIC_API_URL = "https://api.yaffle.test/"

    expect(resolveProviderDiscoveryCallbackUrl()).toBe(
      "https://api.yaffle.test/api/internal/provider-discovery/results",
    )
  })

  test("throws when public api url is missing", () => {
    delete process.env.YAFFLE_PUBLIC_API_URL

    expect(() => resolveProviderDiscoveryCallbackUrl()).toThrow(
      "YAFFLE_PUBLIC_API_URL must be configured",
    )
  })
})

describe("handleProviderDiscoveryJob", () => {
  test("dispatches with callback derived from public api url", async () => {
    process.env.YAFFLE_PROVIDER_DISCOVERY_ENABLED = "true"
    process.env.YAFFLE_PROVIDER_DISCOVERY_AGENT_ENDPOINT = "https://provider-discovery-agent.test/discover"
    process.env.YAFFLE_PROVIDER_DISCOVERY_AGENT_TOKEN = "provider-agent-token"
    process.env.YAFFLE_PROVIDER_DISCOVERY_CALLBACK_SECRET = "provider-callback-secret"
    process.env.YAFFLE_PUBLIC_API_URL = "https://api.yaffle.test"

    const originalFetch = globalThis.fetch
    let requestBody: Record<string, unknown> | null = null

    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(String(input), init)
        requestBody = await request.json() as Record<string, unknown>
        return Response.json({ data: { accepted: true } }, { status: 202 })
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch

    try {
      await handleProviderDiscoveryJob(baseJob as never)
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(requestBody).toMatchObject({
      requestId: baseJob.id,
      providerType: "hookdeck",
      callbackUrl: "https://api.yaffle.test/api/internal/provider-discovery/results",
      callbackAuth: {
        mode: "hmac-sha256",
        secretRef: "YAFFLE_PROVIDER_DISCOVERY_CALLBACK_SECRET",
      },
    })
  })
})
