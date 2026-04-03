import { initTelemetry, logger as log, shutdownTelemetry } from "./lib/telemetry.ts"

import { Hono } from "hono"
import { logger } from "hono/logger"

import { httpTelemetry } from "./middleware/http-telemetry.ts"
import { webhooksRoute } from "./routes/webhooks.ts"
import { previewsRoute } from "./routes/previews.ts"
import { runsRoute } from "./routes/runs.ts"
import { environmentsRoute } from "./routes/environments.ts"
import { orgsRoute } from "./routes/orgs.ts"
import { reposRoute } from "./routes/repos.ts"
import { dependenciesRoute } from "./routes/dependencies.ts"
import { authApiRoute } from "./routes/auth-api.ts"
import { healthRoute } from "./routes/health.ts"
import { wellKnownRoute } from "./routes/well-known.ts"
import { runnerRoute } from "./routes/runner.ts"
import { scannerRoute } from "./routes/scanner.ts"
import { tfcRoute, stateUploadRoute } from "./routes/tfc/index.ts"
import { providerDiscoveryRoute } from "./routes/provider-discovery.ts"
import { integrationsRoute } from "./routes/integrations.ts"
import { repoMappingsRoute } from "./routes/repo-mappings.ts"
import { billingRoute } from "./routes/billing.ts"
import { stripeWebhooksRoute } from "./routes/stripe-webhooks.ts"
import { auth } from "./lib/better-auth.ts"
import { startScheduler, stopScheduler } from "./lib/scheduler.ts"
import { startJobWorker, stopJobWorker } from "./lib/job-worker.ts"
import { previewMutex } from "./lib/webhook-handler.ts"
import { ensureDefaultProviderCredentialSignatures } from "./db/queries/provider-credential-signatures.ts"

// Initialize OTel SDK (no-op if OTEL_EXPORTER_OTLP_ENDPOINT not set)
await initTelemetry()

const schedulerDisabled = process.env.YAFFLE_DISABLE_SCHEDULER === "true"

type ProcessRole = "all" | "api" | "scheduler" | "job-worker"

function resolveProcessRole(value: string | undefined): ProcessRole {
  const normalized = value?.trim().toLowerCase()
  if (
    normalized === "all"
    || normalized === "api"
    || normalized === "scheduler"
    || normalized === "job-worker"
  ) {
    return normalized
  }

  return "all"
}

const processRole = resolveProcessRole(process.env.YAFFLE_PROCESS_ROLE)
const startSchedulerRole = processRole === "all" || processRole === "scheduler"
const startJobWorkerRole = processRole === "all" || processRole === "job-worker"

log.info("Control plane role configuration", {
  processRole,
  schedulerDisabled,
  startSchedulerRole,
  startJobWorkerRole,
})

if (startSchedulerRole && !schedulerDisabled) {
  // Start the IaC job scheduler
  await startScheduler()
  log.info("IaC job scheduler started")
} else if (startSchedulerRole && schedulerDisabled) {
  log.info("IaC job scheduler disabled via YAFFLE_DISABLE_SCHEDULER=true")
} else {
  log.info("IaC job scheduler disabled for process role", { processRole })
}

// Start the generic job worker (for org provisioning, etc.)
if (startJobWorkerRole) {
  startJobWorker()
  log.info("Job worker started")
} else {
  log.info("Job worker disabled for process role", { processRole })
}

// Ensure default provider credential signature catalog exists.
await ensureDefaultProviderCredentialSignatures()
log.info("Provider credential signatures ensured")

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
  log.warn("404 Not Found", { method: c.req.method, path: c.req.path, url: c.req.url })
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

// State upload endpoint (unauthenticated - acts like presigned URL)
// Must be registered BEFORE /tfc route to take precedence
app.route("/tfc/api/v2", stateUploadRoute)

// TFC-compatible API (for terraform login, state, workspaces)
app.route("/tfc", tfcRoute)

// API routes
app.route("/api/webhooks", webhooksRoute)
app.route("/api/webhooks/stripe", stripeWebhooksRoute)
app.route("/api/previews", previewsRoute)
app.route("/api/runs", runsRoute)
app.route("/api/environments", environmentsRoute)
app.route("/api/orgs", orgsRoute)
app.route("/api/orgs", reposRoute) // Nested under /api/orgs for /:org/repos/... routes
app.route("/api", dependenciesRoute) // Dependency graph API (/api/orgs/:org/dependencies/*)
app.route("/api/integrations", integrationsRoute) // GitHub installation/repo listing
app.route("/api/orgs", repoMappingsRoute) // Repo-to-org mapping CRUD
app.route("/api/orgs", billingRoute) // Billing checkout & portal
app.route("/api/users", authApiRoute) // Custom user endpoints (e.g., /api/users/me)
app.route("/api/runner", runnerRoute) // Runner worker API (claim, heartbeat, complete)
app.route("/api/scanner", scannerRoute) // Scanner worker API (claim, heartbeat, complete)
app.route("/api/internal/provider-discovery", providerDiscoveryRoute)
app.route("/api", healthRoute)

const port = Number(process.env.PORT ?? 3000)

log.info(`yaffle api listening on :${port}`, { port })

// Graceful shutdown
async function shutdown() {
  log.info("shutting down")
  if (startSchedulerRole && !schedulerDisabled) {
    await stopScheduler()
  }
  if (startJobWorkerRole) {
    stopJobWorker()
  }
  if ("close" in previewMutex) {
    await (previewMutex as { close(): Promise<void> }).close()
  }
  await shutdownTelemetry()
  process.exit(0)
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

export default {
  port,
  hostname: "0.0.0.0",
  fetch: app.fetch,
  // Disable Bun's default 10s idle timeout — SSE connections can be idle
  // for extended periods between events. Our own 30s heartbeat keeps
  // connections alive at the EventSource/proxy layer.
  idleTimeout: 0,
}
