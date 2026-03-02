import { initTelemetry, logger as log, shutdownTelemetry } from "./lib/telemetry.ts"

import { Hono } from "hono"
import { logger } from "hono/logger"

import { webhooksRoute } from "./routes/webhooks.ts"
import { previewsRoute } from "./routes/previews.ts"
import { healthRoute } from "./routes/health.ts"

// Initialize OTel SDK (no-op if OTEL_EXPORTER_OTLP_ENDPOINT not set)
await initTelemetry()

const app = new Hono()

app.use("*", logger())

app.route("/api/webhooks", webhooksRoute)
app.route("/api/previews", previewsRoute)
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
}
