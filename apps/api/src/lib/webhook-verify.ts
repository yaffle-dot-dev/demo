import { WebhookVerificationError } from "@yaffle/shared"

const ALGORITHM = "SHA-256"
const SIGNATURE_PREFIX = "sha256="

/**
 * Verify the HMAC-SHA256 signature of a GitHub webhook payload.
 * Uses Web Crypto API (available in Bun natively).
 */
export async function verifyWebhookSignature(
  payload: string,
  signature: string | undefined,
  secret: string,
): Promise<void> {
  if (!signature) {
    throw new WebhookVerificationError("missing x-hub-signature-256 header")
  }

  if (!secret) {
    // In development without secrets configured, skip verification
    console.warn("GITHUB_WEBHOOK_SECRET not set, skipping webhook signature verification")
    return
  }

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: ALGORITHM },
    false,
    ["sign"],
  )

  const signatureBytes = await crypto.subtle.sign("HMAC", key, encoder.encode(payload))
  const computed = `${SIGNATURE_PREFIX}${toHex(signatureBytes)}`

  if (!timingSafeEqual(computed, signature)) {
    throw new WebhookVerificationError()
  }
}

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
