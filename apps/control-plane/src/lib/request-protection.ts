import type { Context } from "hono"

interface RateLimitEntry {
  count: number
  resetAt: number
}

interface RateLimitOptions {
  bucket: string
  limit: number
  windowMs: number
}

export class RequestBodyTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`)
    this.name = "RequestBodyTooLargeError"
  }
}

// This in-process limiter is a lightweight backstop for semantic endpoints.
// It is not a substitute for production edge/CDN/WAF rate limiting.
const rateLimitStore = new Map<string, RateLimitEntry>()

function getClientAddress(c: Context): string {
  const forwardedFor = c.req.header("x-forwarded-for")
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() || "unknown"
  }

  return c.req.header("x-real-ip") ?? "unknown"
}

export function enforceRateLimit(c: Context, options: RateLimitOptions): Response | null {
  const now = Date.now()
  const client = getClientAddress(c)
  const key = `${options.bucket}:${client}`
  const existing = rateLimitStore.get(key)

  if (!existing || existing.resetAt <= now) {
    rateLimitStore.set(key, {
      count: 1,
      resetAt: now + options.windowMs,
    })
    return null
  }

  if (existing.count >= options.limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
    return new Response(
      JSON.stringify({
        error: {
          code: "RATE_LIMITED",
          message: "rate limit exceeded",
        },
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(retryAfterSeconds),
        },
      },
    )
  }

  existing.count += 1
  rateLimitStore.set(key, existing)
  return null
}

export async function readRequestBodyBytes(req: Request, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = req.headers.get("content-length")
  if (declaredLength) {
    const parsed = Number.parseInt(declaredLength, 10)
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new RequestBodyTooLargeError(maxBytes)
    }
  }

  if (!req.body) {
    return new Uint8Array()
  }

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }

    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new RequestBodyTooLargeError(maxBytes)
    }

    chunks.push(value)
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  return body
}

export async function readRequestBodyText(req: Request, maxBytes: number): Promise<string> {
  const bytes = await readRequestBodyBytes(req, maxBytes)
  return new TextDecoder().decode(bytes)
}

export function resetRateLimitStore(): void {
  rateLimitStore.clear()
}
