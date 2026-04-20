import { Buffer } from "node:buffer"

import { WebhookVerificationError } from "@yaffle/shared"

import { logger } from "./telemetry.ts"

const ALGORITHM = "SHA-256"
const GITHUB_SIGNATURE_PREFIX = "sha256="

function allowInsecureWebhooks(): boolean {
  return process.env.YAFFLE_ALLOW_INSECURE_WEBHOOKS === "true"
}

function ensureSecretConfigured(secret: string): void {
  if (secret) {
    return
  }

  if (allowInsecureWebhooks()) {
    logger.warn("insecure webhook verification bypass enabled")
    return
  }

  throw new WebhookVerificationError("webhook secret not configured")
}

async function computeHmac(payload: string, secret: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: ALGORITHM },
    false,
    ["sign"],
  )

  return crypto.subtle.sign("HMAC", key, encoder.encode(payload))
}

function anyTimingSafeEqual(computed: string, candidates: Array<string | undefined>): boolean {
  return candidates.some((candidate) => candidate !== undefined && timingSafeEqual(computed, candidate))
}

/**
 * Verify the HMAC-SHA256 signature of a GitHub webhook payload.
 * Uses Web Crypto API (available in Bun natively).
 */
export async function verifyGithubWebhookSignature(
  payload: string,
  signature: string | undefined,
  secret: string,
): Promise<void> {
  if (!signature) {
    throw new WebhookVerificationError("missing x-hub-signature-256 header")
  }

  ensureSecretConfigured(secret)
  if (!secret && allowInsecureWebhooks()) {
    return
  }

  const computed = `${GITHUB_SIGNATURE_PREFIX}${toHex(await computeHmac(payload, secret))}`

  if (!timingSafeEqual(computed, signature)) {
    throw new WebhookVerificationError()
  }
}

/**
 * Verify Hookdeck's HMAC-SHA256 destination signature.
 * Hookdeck encodes the digest as base64 and may provide a secondary header
 * during secret rotation.
 */
export async function verifyHookdeckWebhookSignature(
  payload: string,
  signature: string | undefined,
  signature2: string | undefined,
  secret: string,
): Promise<void> {
  if (!signature && !signature2) {
    throw new WebhookVerificationError("missing x-hookdeck-signature header")
  }

  ensureSecretConfigured(secret)
  if (!secret && allowInsecureWebhooks()) {
    return
  }

  const computed = Buffer.from(await computeHmac(payload, secret)).toString("base64")

  if (!anyTimingSafeEqual(computed, [signature, signature2])) {
    throw new WebhookVerificationError()
  }
}

export const verifyWebhookSignature = verifyGithubWebhookSignature

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  const encoder = new TextEncoder()
  const bufA = encoder.encode(a)
  const bufB = encoder.encode(b)
  let result = 0
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i]
  }
  return result === 0
}
