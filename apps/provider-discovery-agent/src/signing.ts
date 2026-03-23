const SIGNATURE_PREFIX = "sha256="

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
}

export function timingSafeEqual(a: string, b: string): boolean {
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

export async function signPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload))
  return `${SIGNATURE_PREFIX}${toHex(signature)}`
}

export async function buildSignedCallbackHeaders(params: {
  body: string
  secret: string
  timestampMs?: number
  nonce?: string
}): Promise<HeadersInit> {
  const timestampMs = (params.timestampMs ?? Date.now()).toString()
  const nonce = params.nonce ?? crypto.randomUUID()
  const message = `${timestampMs}.${nonce}.${params.body}`
  const signature = await signPayload(message, params.secret)

  return {
    "content-type": "application/json",
    "x-yaffle-timestamp": timestampMs,
    "x-yaffle-nonce": nonce,
    "x-yaffle-signature": signature,
  }
}
