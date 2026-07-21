import type { Context, Next } from "hono"
import {
  tracer,
  getHttpRequestDurationHistogram,
  getHttpRequestCounter,
  SpanStatusCode,
} from "../lib/telemetry.ts"

const STATE_UPLOAD_CAPABILITY_PATH = /(\/state-versions\/[^/]+\/upload(?:-json)?\/)[^/?#]+/

export function redactHttpUrl(rawUrl: string): { url: string; path: string } {
  const parsed = new URL(rawUrl)
  parsed.pathname = parsed.pathname.replace(STATE_UPLOAD_CAPABILITY_PATH, "$1:capability")
  for (const name of ["token", "access_token", "api_key"]) {
    if (parsed.searchParams.has(name)) {
      parsed.searchParams.set(name, ":capability")
    }
  }
  return { url: parsed.toString(), path: parsed.pathname }
}

/**
 * HTTP telemetry middleware that:
 * 1. Creates a root span for each request
 * 2. Records request duration histogram
 * 3. Records request counter by method/route/status
 */
export async function httpTelemetry(c: Context, next: Next): Promise<void | Response> {
  const start = Date.now()
  const method = c.req.method
  const requestUrl = new URL(c.req.url)
  const redacted = redactHttpUrl(c.req.url)
  const path = redacted.path

  return tracer.startActiveSpan(
    `${method} ${path}`,
    {
      attributes: {
        "http.method": method,
        "http.url": redacted.url,
        "http.target": path,
        "http.host": requestUrl.host,
        "http.scheme": requestUrl.protocol.replace(":", ""),
      },
    },
    async (span) => {
      try {
        await next()

        const status = c.res.status
        const duration = Date.now() - start

        // Determine the route pattern (e.g., /api/previews/:id)
        // Hono doesn't expose matched route easily, so we normalize common patterns
        const route = normalizeRoute(path)

        span.setAttributes({
          "http.status_code": status,
          "http.route": route,
          "yaffle.duration_ms": duration,
        })

        if (status >= 400) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `HTTP ${status}`,
          })
        }

        // Record metrics
        const attrs = { method, route, status: String(status) }
        getHttpRequestDurationHistogram().record(duration, attrs)
        getHttpRequestCounter().add(1, attrs)
      } catch (err) {
        const duration = Date.now() - start
        const route = normalizeRoute(path)

        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        })
        span.recordException(err instanceof Error ? err : new Error(String(err)))

        // Record metrics for errors
        const attrs = { method, route, status: "500" }
        getHttpRequestDurationHistogram().record(duration, attrs)
        getHttpRequestCounter().add(1, attrs)

        throw err
      } finally {
        span.end()
      }
    },
  )
}

/**
 * Normalize URL paths to route patterns for better metric aggregation.
 * Replaces UUIDs and numeric IDs with placeholders.
 */
function normalizeRoute(path: string): string {
  return (
    path
      // Replace UUIDs
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
      // Replace numeric IDs
      .replace(/\/\d+/g, "/:id")
      // Normalize trailing slashes
      .replace(/\/+$/, "") || "/"
  )
}
