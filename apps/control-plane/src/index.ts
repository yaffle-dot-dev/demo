import { initTelemetry, logger as log, shutdownTelemetry } from "./lib/telemetry.ts"

import { Hono } from "hono"
import { logger } from "hono/logger"

import { httpTelemetry } from "./middleware/http-telemetry.ts"
import { webhooksRoute } from "./routes/webhooks.ts"
import { previewsRoute } from "./routes/previews.ts"
import { runsRoute } from "./routes/runs.ts"
import { environmentsRoute } from "./routes/environments.ts"
import { orgsRoute } from "./routes/orgs.ts"
import { authRoute } from "./routes/auth.ts"
import { authApiRoute } from "./routes/auth-api.ts"
import { healthRoute } from "./routes/health.ts"

// Initialize OTel SDK (no-op if OTEL_EXPORTER_OTLP_ENDPOINT not set)
await initTelemetry()

const app = new Hono()

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

// API routes - mount BEFORE OpenAuth to ensure /api/* is handled first
app.route("/api/webhooks", webhooksRoute)
app.route("/api/previews", previewsRoute)
app.route("/api/runs", runsRoute)
app.route("/api/environments", environmentsRoute)
app.route("/api/orgs", orgsRoute)
app.route("/api/auth", authApiRoute)
app.route("/api", healthRoute)

// OpenAuth issuer mounted at root - handles /authorize, /token, /jwks, /.well-known/*, /:provider/*
// Must be last so it doesn't intercept /api routes
app.route("/", authRoute)

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
