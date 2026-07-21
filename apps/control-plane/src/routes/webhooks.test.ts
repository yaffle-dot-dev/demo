import { Buffer } from "node:buffer"

import { afterEach, describe, expect, test } from "@yaffle/test"
import { Hono } from "hono"

import { webhooksRoute } from "./webhooks.ts"

const app = new Hono()
app.route("/api/webhooks", webhooksRoute)

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
    .map((byte) => byte.toString(16).padStart(2, "0"))
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
  delete process.env.GITHUB_WEBHOOK_SECRET
  delete process.env.HOOKDECK_WEBHOOK_SECRET
  delete process.env.YAFFLE_ALLOW_INSECURE_WEBHOOKS
})

describe("webhooksRoute", () => {
  test("accepts direct GitHub deliveries", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "github-secret"

    const body = JSON.stringify({ zen: "keep it logically awesome" })
    const signature = await signHex(body, process.env.GITHUB_WEBHOOK_SECRET)

    const res = await app.request("/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hub-signature-256": signature,
      },
      body,
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: {
        ignored: true,
        reason: "unhandled event: ping",
      },
    })
  })

  test("accepts Hookdeck deliveries when Hookdeck verified the GitHub source", async () => {
    process.env.HOOKDECK_WEBHOOK_SECRET = "hookdeck-secret"

    const body = JSON.stringify({ zen: "hookdeck front door" })
    const signature = await signBase64(body, process.env.HOOKDECK_WEBHOOK_SECRET)

    const res = await app.request("/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hookdeck-signature": signature,
        "x-hookdeck-verified": "true",
        "x-hookdeck-source-name": "github-app",
        "x-hookdeck-destination-name": "preview-control-plane",
      },
      body,
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: {
        ignored: true,
        reason: "unhandled event: ping",
      },
    })
  })

  test("falls back to GitHub verification for unverified Hookdeck deliveries", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "github-secret"
    process.env.HOOKDECK_WEBHOOK_SECRET = "hookdeck-secret"

    const body = JSON.stringify({ zen: "verify both" })
    const hookdeckSignature = await signBase64(body, process.env.HOOKDECK_WEBHOOK_SECRET)
    const githubSignature = await signHex(body, process.env.GITHUB_WEBHOOK_SECRET)

    const res = await app.request("/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hookdeck-signature": hookdeckSignature,
        "x-hookdeck-verified": "false",
        "x-hub-signature-256": githubSignature,
      },
      body,
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: {
        ignored: true,
        reason: "unhandled event: ping",
      },
    })
  })

  test("rejects Hookdeck deliveries that were not source-verified and lack a GitHub signature", async () => {
    process.env.HOOKDECK_WEBHOOK_SECRET = "hookdeck-secret"

    const body = JSON.stringify({ zen: "missing github signature" })
    const signature = await signBase64(body, process.env.HOOKDECK_WEBHOOK_SECRET)

    const res = await app.request("/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hookdeck-signature": signature,
      },
      body,
    })

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({
      error: {
        code: "WEBHOOK_VERIFICATION_FAILED",
        message: "invalid signature",
      },
    })
  })
})
