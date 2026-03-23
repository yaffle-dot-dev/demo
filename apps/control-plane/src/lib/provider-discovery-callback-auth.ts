const SIGNATURE_PREFIX = "sha256="
const MAX_AGE_MS = 5 * 60 * 1000

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }

  const encoder = new TextEncoder()
  const aBytes = encoder.encode(a)
  const bBytes = encoder.encode(b)
  let result = 0

  for (let index = 0; index < aBytes.length; index += 1) {
    result |= aBytes[index] ^ bBytes[index]
  }

  return result === 0
}

async function computeSignature(
  payload: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )

  const bytes = await crypto.subtle.sign("HMAC", key, encoder.encode(payload))
  return `${SIGNATURE_PREFIX}${toHex(bytes)}`
}

export async function verifyProviderDiscoveryCallbackSignature(params: {
  body: string
  timestampHeader: string | undefined
  nonceHeader: string | undefined
  signatureHeader: string | undefined
  secret: string
  now?: number
}): Promise<boolean> {
  const { body, timestampHeader, nonceHeader, signatureHeader, secret, now = Date.now() } = params

  if (!secret || !timestampHeader || !nonceHeader || !signatureHeader) {
    return false
  }

  const timestampMs = Number(timestampHeader)
  if (!Number.isFinite(timestampMs)) {
    return false
  }

  if (Math.abs(now - timestampMs) > MAX_AGE_MS) {
    return false
  }

  const payload = `${timestampHeader}.${nonceHeader}.${body}`
  const expected = await computeSignature(payload, secret)
  return timingSafeEqual(expected, signatureHeader)
}
