import { describe, expect, test } from "bun:test"

import { buildSignedCallbackHeaders } from "../../../provider-discovery-agent/src/signing.ts"

import { verifyProviderDiscoveryCallbackSignature } from "./provider-discovery-callback-auth.ts"

describe("provider discovery signature compatibility", () => {
  test("cloudflare agent signing matches control-plane verification", async () => {
    const body = JSON.stringify({
      requestId: "d2f939e8-8334-40e9-8cb4-08646fa2f198",
      providerType: "cloudflare",
      status: "succeeded",
      confidence: "high",
      exactEnvVars: ["CLOUDFLARE_API_TOKEN"],
      prefixEnvVars: ["CLOUDFLARE_"],
      sources: [],
      reasoningSummary: "test",
    })
    const secret = "compat-shared-secret"

    const headers = new Headers(await buildSignedCallbackHeaders({
      body,
      secret,
      timestampMs: 1_700_000_000_000,
      nonce: "compat-nonce",
    }))

    const verified = await verifyProviderDiscoveryCallbackSignature({
      body,
      timestampHeader: headers.get("x-yaffle-timestamp") ?? undefined,
      nonceHeader: headers.get("x-yaffle-nonce") ?? undefined,
      signatureHeader: headers.get("x-yaffle-signature") ?? undefined,
      secret,
      now: 1_700_000_000_500,
    })

    expect(verified).toBe(true)
  })
})
