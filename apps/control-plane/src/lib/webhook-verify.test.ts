import { Buffer } from "node:buffer"

import { afterEach, describe, expect, test } from "@yaffle/test"

import { WebhookVerificationError } from "@yaffle/shared"

import { verifyGithubWebhookSignature, verifyHookdeckWebhookSignature } from "./webhook-verify.ts"

async function signHex(payload: string, secret: string): Promise<string> {
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

async function signBase64(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )

  return Buffer.from(await crypto.subtle.sign("HMAC", key, encoder.encode(payload))).toString(
    "base64",
  )
}

afterEach(() => {
  delete process.env.YAFFLE_ALLOW_INSECURE_WEBHOOKS
})

describe("verifyGithubWebhookSignature", () => {
  test("rejects when webhook secret is missing", async () => {
    await expect(verifyGithubWebhookSignature("{}", "sha256=abc", "")).rejects.toBeInstanceOf(
      WebhookVerificationError,
    )
  })

  test("allows explicit insecure dev override", async () => {
    process.env.YAFFLE_ALLOW_INSECURE_WEBHOOKS = "true"

    await expect(verifyGithubWebhookSignature("{}", "sha256=abc", "")).resolves.toBeUndefined()
  })

  test("accepts valid signatures when secret is configured", async () => {
    const payload = JSON.stringify({ hello: "world" })
    const secret = "super-secret"
    const signature = await signHex(payload, secret)

    await expect(verifyGithubWebhookSignature(payload, signature, secret)).resolves.toBeUndefined()
  })
})

describe("verifyHookdeckWebhookSignature", () => {
  test("rejects when Hookdeck secret is missing", async () => {
    await expect(verifyHookdeckWebhookSignature("{}", "abc", undefined, "")).rejects.toBeInstanceOf(
      WebhookVerificationError,
    )
  })

  test("accepts valid primary signatures when secret is configured", async () => {
    const payload = JSON.stringify({ hello: "world" })
    const secret = "super-secret"
    const signature = await signBase64(payload, secret)

    await expect(
      verifyHookdeckWebhookSignature(payload, signature, undefined, secret),
    ).resolves.toBeUndefined()
  })

  test("accepts valid secondary signatures during secret rotation", async () => {
    const payload = JSON.stringify({ hello: "world" })
    const secret = "super-secret"
    const signature2 = await signBase64(payload, secret)

    await expect(
      verifyHookdeckWebhookSignature(payload, "bad-signature", signature2, secret),
    ).resolves.toBeUndefined()
  })
})
