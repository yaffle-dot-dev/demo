import { describe, expect, test } from "@yaffle/test"

import { verifyProviderDiscoveryCallbackSignature } from "./provider-discovery-callback-auth.ts"

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
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

describe("verifyProviderDiscoveryCallbackSignature", () => {
  test("accepts valid signatures", async () => {
    const body = JSON.stringify({ requestId: "9ec80f4c-bec6-45f8-84f6-db1b3a998722" })
    const timestamp = Date.now().toString()
    const nonce = "nonce-1"
    const payload = `${timestamp}.${nonce}.${body}`
    const secret = "callback-test-secret"
    const signature = await sign(payload, secret)

    await expect(
      verifyProviderDiscoveryCallbackSignature({
        body,
        timestampHeader: timestamp,
        nonceHeader: nonce,
        signatureHeader: signature,
        secret,
      }),
    ).resolves.toBe(true)
  })

  test("rejects stale signatures", async () => {
    const now = Date.now()
    const staleTimestamp = (now - 6 * 60 * 1000).toString()
    const nonce = "nonce-2"
    const body = JSON.stringify({ requestId: "9ec80f4c-bec6-45f8-84f6-db1b3a998722" })
    const payload = `${staleTimestamp}.${nonce}.${body}`
    const secret = "callback-test-secret"
    const signature = await sign(payload, secret)

    await expect(
      verifyProviderDiscoveryCallbackSignature({
        body,
        timestampHeader: staleTimestamp,
        nonceHeader: nonce,
        signatureHeader: signature,
        secret,
        now,
      }),
    ).resolves.toBe(false)
  })

  test("rejects when nonce is missing", async () => {
    const now = Date.now()
    const timestamp = now.toString()
    const body = JSON.stringify({ requestId: "9ec80f4c-bec6-45f8-84f6-db1b3a998722" })
    const secret = "callback-test-secret"
    const signature = await sign(`${timestamp}.nonce.${body}`, secret)

    await expect(
      verifyProviderDiscoveryCallbackSignature({
        body,
        timestampHeader: timestamp,
        nonceHeader: undefined,
        signatureHeader: signature,
        secret,
        now,
      }),
    ).resolves.toBe(false)
  })
})
