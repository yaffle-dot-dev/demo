import { initTelemetry, logger as log, shutdownTelemetry } from "./lib/telemetry.ts"

import { Hono } from "hono"
import { logger } from "hono/logger"
import { cors } from "hono/cors"

import { httpTelemetry } from "./middleware/http-telemetry.ts"
import { webhooksRoute } from "./routes/webhooks.ts"
import { previewsRoute } from "./routes/previews.ts"
import { environmentsRoute } from "./routes/environments.ts"
import { orgsRoute } from "./routes/orgs.ts"
import { reposRoute } from "./routes/repos.ts"
import { dependenciesRoute } from "./routes/dependencies.ts"
import { authApiRoute } from "./routes/auth-api.ts"
import { healthRoute } from "./routes/health.ts"
import { wellKnownRoute } from "./routes/well-known.ts"
import { tfcRoute } from "./routes/tfc/index.ts"
import { auth } from "./lib/better-auth.ts"

// Initialize OTel SDK (no-op if OTEL_EXPORTER_OTLP_ENDPOINT not set)
await initTelemetry()

const app = new Hono()

// CORS for auth endpoints (needed for cross-origin requests from web app)
app.use(
  "/api/auth/*",
  cors({
    origin: (origin) => origin, // Allow all origins for now, tighten in production
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["POST", "GET", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
    credentials: true,
  }),
)

// Telemetry middleware - creates root span and records metrics for all requests
app.use("*", httpTelemetry)
app.use("*", logger())

// Global error handler — consistent { error: { code, message } } shape
app.onError((err, c) => {
  log.error("unhandled error", { error: err.message, stack: err.stack })
  const status = "status" in err && typeof err.status === "number" ? err.status : 500
  return c.json(
    { error: { code: "INTERNAL_ERROR", message: err.message } },
    status as 500,
  )
})

// 404 handler
app.notFound((c) => {
  return c.json({ error: { code: "NOT_FOUND", message: "not found" } }, 404)
})

// BetterAuth handler - handles /api/auth/*
app.on(["POST", "GET"], "/api/auth/*", async (c) => {
  log.info(`BetterAuth request: ${c.req.method} ${c.req.path}`)
  try {
    const response = await auth.handler(c.req.raw)
    log.info(`BetterAuth response: ${response.status}`)
    return response
  } catch (err) {
    log.error("BetterAuth handler error", { error: err instanceof Error ? err.message : String(err) })
    throw err
  }
})

// Service discovery for Terraform CLI
app.route("/.well-known", wellKnownRoute)

// TFC-compatible API (for terraform login, state, workspaces)
app.route("/tfc", tfcRoute)

// API routes
app.route("/api/webhooks", webhooksRoute)
app.route("/api/previews", previewsRoute)
app.route("/api/environments", environmentsRoute)
app.route("/api/orgs", orgsRoute)
app.route("/api/orgs", reposRoute) // Nested under /api/orgs for /:org/repos/... routes
app.route("/api", dependenciesRoute) // Dependency graph API (/api/orgs/:org/dependencies/*)
app.route("/api/users", authApiRoute) // Custom user endpoints (e.g., /api/users/me)
app.route("/api", healthRoute)

const port = Number(process.env.PORT ?? 3000)

log.info(`yaffle api listening on :${port}`, { port })

// Graceful shutdown
process.on("SIGTERM", async () => {
  log.info("shutting down")
  await shutdownTelemetry()
  process.exit(0)
})

process.on("SIGINT", async () => {
  log.info("shutting down")
  await shutdownTelemetry()
  process.exit(0)
})

export default {
  port,
  fetch: app.fetch,
  // Disable Bun's default 10s idle timeout — SSE connections can be idle
  // for extended periods between events. Our own 30s heartbeat keeps
  // connections alive at the EventSource/proxy layer.
  idleTimeout: 0,
}
