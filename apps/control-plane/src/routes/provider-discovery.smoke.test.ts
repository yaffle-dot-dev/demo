import { afterEach, beforeEach, describe, expect, test } from "@yaffle/test"
import { eq } from "drizzle-orm"
import { Hono } from "hono"

// Import test utils FIRST so dev auth is enabled before route modules load.
import { cleanupTestData, createTestContext, type TestContext } from "../test-utils/auth.ts"

import { findPendingJobsByType } from "../db/queries/jobs.ts"
import { findProviderCredentialSignatureByType } from "../db/queries/provider-credential-signatures.ts"
import { db } from "../lib/db.ts"
import { clearProviderDiscoveryCallbackNonceCacheForTests } from "../lib/provider-discovery-callback-replay.ts"
import { getConnectionReadinessForDeploymentWithDeps } from "../lib/execution-credentials.ts"
import { inferProviderTypeFromEnvVarKeys } from "../lib/provider-credential-inference.ts"
import { providerCredentialSignatures } from "../db/schema.ts"
import { handleProviderDiscoveryJob } from "../jobs/provider-discovery.ts"
import { orgsRoute } from "./orgs.ts"
import { providerDiscoveryRoute } from "./provider-discovery.ts"

const app = new Hono()
app.route("/api/orgs", orgsRoute)
app.route("/api/internal/provider-discovery", providerDiscoveryRoute)

let adminCtx: TestContext
let originalFetch: typeof globalThis.fetch & { preconnect?: unknown }
const createdProviderTypes = new Set<string>()

function providerType(name: string): string {
  const value = `${name}-${crypto.randomUUID().slice(0, 8)}`.toLowerCase()
  createdProviderTypes.add(value)
  return value
}

function authHeaders(): Headers {
  return new Headers(adminCtx.headers)
}

async function signCallback(params: {
  body: string
  secret: string
  timestamp: string
  nonce: string
}): Promise<string> {
  const payload = `${params.timestamp}.${params.nonce}.${params.body}`
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(params.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )

  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))
  const hex = Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")

  return `sha256=${hex}`
}

function mockDiscoveryAgent(handler: (request: Request) => Promise<Response>): void {
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request
        ? input
        : new Request(String(input), init)

      const url = new URL(request.url)
      if (url.origin === "https://provider-discovery-agent.test") {
        return handler(request)
      }

      return originalFetch(input as any, init)
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch
}

beforeEach(async () => {
  adminCtx = await createTestContext({
    orgSlug: `provider-discovery-smoke-${crypto.randomUUID().slice(0, 8)}`,
    role: "admin",
  })

  originalFetch = globalThis.fetch
  clearProviderDiscoveryCallbackNonceCacheForTests()

  process.env.YAFFLE_PROVIDER_DISCOVERY_ENABLED = "true"
  process.env.YAFFLE_PROVIDER_DISCOVERY_AGENT_ENDPOINT = "https://provider-discovery-agent.test/discover"
  process.env.YAFFLE_PROVIDER_DISCOVERY_AGENT_TOKEN = "provider-agent-token"
  process.env.YAFFLE_PROVIDER_DISCOVERY_CALLBACK_SECRET = "provider-callback-secret"
  process.env.YAFFLE_PUBLIC_API_URL = "https://yaffle.local"
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  clearProviderDiscoveryCallbackNonceCacheForTests()
  await cleanupTestData()

  for (const entry of createdProviderTypes) {
    await db
      .delete(providerCredentialSignatures)
      .where(eq(providerCredentialSignatures.providerType, entry))
  }
  createdProviderTypes.clear()
})

describe("provider discovery smoke flow", () => {
  test("queues discovery for a missing provider, dispatches the agent job, and applies the signed callback", async () => {
    const missingProvider = providerType("smokeedge")

    const readiness = await getConnectionReadinessForDeploymentWithDeps(
      {
        orgId: adminCtx.org.id,
        repo: "smoke/acme-infra",
        environmentName: "pr-42",
        workspacePath: "infra",
        runGroupId: null,
      },
      {
        getProvidersForDeployment: async () => [missingProvider],
        listConnectionsForOrg: async () => [],
        resolveConnectionEnv: async () => {
          throw new Error("resolveConnectionEnv should not run for missing providers")
        },
      },
    )

    expect(readiness.status).toBe("missing")
    expect(readiness.missingProviders).toEqual([missingProvider])

    const queuedJobs = await findPendingJobsByType(adminCtx.org.id, "provider_discovery")
    expect(queuedJobs).toHaveLength(1)

    const queuedJob = queuedJobs[0]
    expect(queuedJob.payload).toMatchObject({
      providerType: missingProvider,
      repo: "smoke/acme-infra",
      environment: "pr-42",
      workspacePath: "infra",
      requestedByOrgId: adminCtx.org.id,
    })

    let dispatchBody: Record<string, unknown> | null = null
    mockDiscoveryAgent(async (request) => {
      expect(request.method).toBe("POST")
      expect(request.headers.get("authorization")).toBe("Bearer provider-agent-token")
      expect(request.headers.get("content-type")).toContain("application/json")
      dispatchBody = await request.json() as Record<string, unknown>
      return Response.json({ data: { accepted: true } }, { status: 202 })
    })

    await handleProviderDiscoveryJob(queuedJob)

    expect(dispatchBody).toMatchObject({
      requestId: queuedJob.id,
      providerType: missingProvider,
      repo: "smoke/acme-infra",
      environment: "pr-42",
      workspacePath: "infra",
      callbackUrl: "https://yaffle.local/api/internal/provider-discovery/results",
      callbackAuth: {
        mode: "hmac-sha256",
        secretRef: "YAFFLE_PROVIDER_DISCOVERY_CALLBACK_SECRET",
      },
      callbackTtlSeconds: 600,
    })

    const callbackPayload = {
      requestId: queuedJob.id,
      status: "succeeded",
      providerType: missingProvider.toUpperCase(),
      displayName: "Smoke Edge",
      suggestedCredentialProviderType: "envvar",
      exactEnvVars: ["SMOKEEDGE_TOKEN", " smokeedge_account_id "],
      prefixEnvVars: ["smokeedge_"],
      confidence: "high",
      sources: [
        {
          url: "https://docs.example.com/smokeedge/auth",
          kind: "docs",
        },
      ],
      reasoningSummary: "API token docs clearly document required env vars.",
    }
    const body = JSON.stringify(callbackPayload)
    const timestamp = Date.now().toString()
    const nonce = `nonce-${crypto.randomUUID()}`
    const signature = await signCallback({
      body,
      secret: "provider-callback-secret",
      timestamp,
      nonce,
    })

    const callbackRes = await app.request("/api/internal/provider-discovery/results", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-yaffle-timestamp": timestamp,
        "x-yaffle-nonce": nonce,
        "x-yaffle-signature": signature,
      },
      body,
    })
    expect(callbackRes.status).toBe(202)
    const callbackResBody = await callbackRes.json() as { data: { accepted: boolean } }
    expect(callbackResBody.data.accepted).toBe(true)

    const signatureRecord = await findProviderCredentialSignatureByType(missingProvider)
    expect(signatureRecord).not.toBeUndefined()
    expect(signatureRecord).toMatchObject({
      providerType: missingProvider,
      displayName: "Smoke Edge",
      suggestedCredentialProviderType: "envvar",
      exactEnvVars: ["SMOKEEDGE_ACCOUNT_ID", "SMOKEEDGE_TOKEN"],
      prefixEnvVars: ["SMOKEEDGE_"],
      isActive: true,
      source: "agent_auto",
    })

    const signaturesRes = await app.request(`/api/orgs/${adminCtx.org.slug}/provider-credential-signatures`, {
      headers: authHeaders(),
    })
    expect(signaturesRes.status).toBe(200)
    const signaturesBody = await signaturesRes.json() as {
      data: Array<{ providerType: string; displayName: string; exactEnvVars: string[] }>
    }
    expect(signaturesBody.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerType: missingProvider,
          displayName: "Smoke Edge",
          exactEnvVars: ["SMOKEEDGE_ACCOUNT_ID", "SMOKEEDGE_TOKEN"],
        }),
      ]),
    )

    await expect(
      inferProviderTypeFromEnvVarKeys(["SMOKEEDGE_TOKEN", "SMOKEEDGE_ACCOUNT_ID"]),
    ).resolves.toBe(missingProvider)

    const readinessAfterApply = await getConnectionReadinessForDeploymentWithDeps(
      {
        orgId: adminCtx.org.id,
        repo: "smoke/acme-infra",
        environmentName: "pr-42",
        workspacePath: "infra",
        runGroupId: null,
      },
      {
        getProvidersForDeployment: async () => [missingProvider],
        listConnectionsForOrg: async () => [],
        resolveConnectionEnv: async () => {
          throw new Error("resolveConnectionEnv should not run for missing providers")
        },
      },
    )

    expect(readinessAfterApply.status).toBe("missing")
    const queuedJobsAfterApply = await findPendingJobsByType(adminCtx.org.id, "provider_discovery")
    expect(queuedJobsAfterApply).toHaveLength(1)
  })

  test("fails closed on dispatch failure, invalid callback auth, replay, and provider mismatch", async () => {
    const failingProvider = providerType("dispatchfail")

    await getConnectionReadinessForDeploymentWithDeps(
      {
        orgId: adminCtx.org.id,
        repo: "smoke/failure-infra",
        environmentName: "pr-7",
        workspacePath: "infra",
        runGroupId: null,
      },
      {
        getProvidersForDeployment: async () => [failingProvider],
        listConnectionsForOrg: async () => [],
        resolveConnectionEnv: async () => {
          throw new Error("resolveConnectionEnv should not run for missing providers")
        },
      },
    )

    const [dispatchJob] = await findPendingJobsByType(adminCtx.org.id, "provider_discovery")
    expect(dispatchJob).toBeDefined()

    mockDiscoveryAgent(async (_request) => new Response("agent unavailable", { status: 502 }))

    await expect(handleProviderDiscoveryJob(dispatchJob)).rejects.toThrow(
      "Provider discovery dispatch failed (502): agent unavailable",
    )

    const callbackProvider = providerType("callbackfail")
    const callbackJobsBefore = await findPendingJobsByType(adminCtx.org.id, "provider_discovery")
    expect(callbackJobsBefore).toHaveLength(1)

    await getConnectionReadinessForDeploymentWithDeps(
      {
        orgId: adminCtx.org.id,
        repo: "smoke/callback-infra",
        environmentName: "pr-8",
        workspacePath: "infra",
        runGroupId: null,
      },
      {
        getProvidersForDeployment: async () => [callbackProvider],
        listConnectionsForOrg: async () => [],
        resolveConnectionEnv: async () => {
          throw new Error("resolveConnectionEnv should not run for missing providers")
        },
      },
    )

    const callbackJobs = await findPendingJobsByType(adminCtx.org.id, "provider_discovery")
    expect(callbackJobs).toHaveLength(2)

    const callbackJob = callbackJobs.find((job) => {
      const payload = job.payload as Record<string, unknown>
      return payload.providerType === callbackProvider
    })
    expect(callbackJob).toBeDefined()

    const validPayload = {
      requestId: callbackJob!.id,
      status: "succeeded",
      providerType: callbackProvider,
      displayName: "Callback Fail",
      suggestedCredentialProviderType: "envvar",
      exactEnvVars: ["CALLBACKFAIL_TOKEN"],
      prefixEnvVars: [],
      confidence: "high",
      sources: [{ url: "https://docs.example.com/callbackfail", kind: "docs" }],
      reasoningSummary: "Valid callback payload for failure checks.",
    }
    const validBody = JSON.stringify(validPayload)
    const validTimestamp = Date.now().toString()
    const validNonce = `nonce-${crypto.randomUUID()}`
    const validSignature = await signCallback({
      body: validBody,
      secret: "provider-callback-secret",
      timestamp: validTimestamp,
      nonce: validNonce,
    })

    const invalidSignatureRes = await app.request("/api/internal/provider-discovery/results", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-yaffle-timestamp": validTimestamp,
        "x-yaffle-nonce": `nonce-${crypto.randomUUID()}`,
        "x-yaffle-signature": "sha256=deadbeef",
      },
      body: validBody,
    })
    expect(invalidSignatureRes.status).toBe(401)

    const mismatchPayload = {
      ...validPayload,
      providerType: providerType("wrongprovider"),
    }
    const mismatchBody = JSON.stringify(mismatchPayload)
    const mismatchTimestamp = Date.now().toString()
    const mismatchNonce = `nonce-${crypto.randomUUID()}`
    const mismatchSignature = await signCallback({
      body: mismatchBody,
      secret: "provider-callback-secret",
      timestamp: mismatchTimestamp,
      nonce: mismatchNonce,
    })

    const mismatchRes = await app.request("/api/internal/provider-discovery/results", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-yaffle-timestamp": mismatchTimestamp,
        "x-yaffle-nonce": mismatchNonce,
        "x-yaffle-signature": mismatchSignature,
      },
      body: mismatchBody,
    })
    expect(mismatchRes.status).toBe(409)

    const successRes = await app.request("/api/internal/provider-discovery/results", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-yaffle-timestamp": validTimestamp,
        "x-yaffle-nonce": validNonce,
        "x-yaffle-signature": validSignature,
      },
      body: validBody,
    })
    expect(successRes.status).toBe(202)

    const replayRes = await app.request("/api/internal/provider-discovery/results", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-yaffle-timestamp": validTimestamp,
        "x-yaffle-nonce": validNonce,
        "x-yaffle-signature": validSignature,
      },
      body: validBody,
    })
    expect(replayRes.status).toBe(409)

    const appliedSignature = await findProviderCredentialSignatureByType(callbackProvider)
    expect(appliedSignature).toMatchObject({
      providerType: callbackProvider,
      displayName: "Callback Fail",
      exactEnvVars: ["CALLBACKFAIL_TOKEN"],
    })

    await expect(
      findProviderCredentialSignatureByType(failingProvider),
    ).resolves.toBeUndefined()
  })
})
