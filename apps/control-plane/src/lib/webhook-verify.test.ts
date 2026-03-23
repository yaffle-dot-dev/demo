import { afterEach, describe, expect, test } from "bun:test"

import { WebhookVerificationError } from "@yaffle/shared"

import { verifyWebhookSignature } from "./webhook-verify.ts"

async function sign(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload))
  const hex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")

  return `sha256=${hex}`
}

afterEach(() => {
  delete process.env.YAFFLE_ALLOW_INSECURE_WEBHOOKS
})

describe("verifyWebhookSignature", () => {
  test("rejects when webhook secret is missing", async () => {
    await expect(
      verifyWebhookSignature("{}", "sha256=abc", ""),
    ).rejects.toBeInstanceOf(WebhookVerificationError)
  })

  test("allows explicit insecure dev override", async () => {
    process.env.YAFFLE_ALLOW_INSECURE_WEBHOOKS = "true"

    await expect(verifyWebhookSignature("{}", "sha256=abc", "")).resolves.toBeUndefined()
  })

  test("accepts valid signatures when secret is configured", async () => {
    const payload = JSON.stringify({ hello: "world" })
    const secret = "super-secret"
    const signature = await sign(payload, secret)

    await expect(verifyWebhookSignature(payload, signature, secret)).resolves.toBeUndefined()
  })
})
