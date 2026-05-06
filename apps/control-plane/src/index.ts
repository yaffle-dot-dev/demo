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
import { localFirstRoute } from "./routes/local-first.ts"
import { cloudCliRoute } from "./routes/cloud-cli.ts"
import { cloudConvergeRoute } from "./routes/cloud-converge.ts"
import { lifecycleRoute } from "./routes/lifecycle.ts"
import { auth } from "./lib/better-auth.ts"
import {
  getLocalFirstGcRuntimeInfo,
  startLocalFirstGcLoop,
  stopLocalFirstGcLoop,
} from "./lib/local-first-gc.ts"
import {
  getSchedulerRuntimeInfo,
  startScheduler,
  stopScheduler,
} from "./lib/scheduler.ts"
import {
  getJobWorkerRuntimeInfo,
  startJobWorker,
  stopJobWorker,
} from "./lib/job-worker.ts"
import { previewMutex } from "./lib/webhook-handler.ts"
import { ensureDefaultProviderCredentialSignatures } from "./db/queries/provider-credential-signatures.ts"
import { getWarmRunnerHybridConfig } from "./lib/warm-runner.ts"

// Initialize OTel SDK (no-op if OTEL_EXPORTER_OTLP_ENDPOINT not set)
await initTelemetry()

function extractAxiomDataset(headers: string | undefined): string | null {
  if (!headers) {
    return null
  }

  for (const part of headers.split(",")) {
    const [rawKey, ...rawValue] = part.split("=")
    if (rawKey?.trim().toLowerCase() === "x-axiom-dataset") {
      const value = rawValue.join("=").trim()
      return value || null
    }
  }

  return null
}

function describeDatabase(urlString: string | undefined): string {
  if (!urlString) {
    return "unset"
  }

  try {
    const url = new URL(urlString)
    const dbName = url.pathname.replace(/^\//, "") || "(default)"
    return `${url.hostname}:${url.port || "default"}/${dbName}`
  } catch {
    return "invalid"
  }
}

function resolveConfiguredRunnerMode(): "ecs" | "local" {
  const isProduction = process.env.NODE_ENV === "production"
  const useEcs = !!process.env.YAFFLE_ECS_CLUSTER
  const forceEcs = process.env.YAFFLE_USE_ECS_RUNNER === "true"

  return (isProduction || forceEcs) && useEcs ? "ecs" : "local"
}

function printStartupBanner(input: {
  hostname: string
  port: number
  processRole: ProcessRole
  schedulerDisabled: boolean
  startSchedulerRole: boolean
  startJobWorkerRole: boolean
}): void {
  const yaffleEnv = process.env.YAFFLE_ENV ?? "development"
  const yaffleEnvSource = process.env.YAFFLE_ENV ? "env" : "default"
  const schedulerInfo = getSchedulerRuntimeInfo()
  const localFirstGcInfo = getLocalFirstGcRuntimeInfo()
  const jobWorkerInfo = getJobWorkerRuntimeInfo()
  const runnerMode = schedulerInfo.spawnerType ?? resolveConfiguredRunnerMode()
  const scannerMode = process.env.YAFFLE_SCANNER_LAMBDA_FUNCTION ? "lambda" : runnerMode
  const scannerDetail = process.env.YAFFLE_SCANNER_LAMBDA_FUNCTION ?? runnerMode
  const warmRunnerHybrid = getWarmRunnerHybridConfig()
  const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? ""
  const otelDataset = extractAxiomDataset(process.env.OTEL_EXPORTER_OTLP_HEADERS)
  const lines = [
    "=== Yaffle Control Plane ===",
    `env: ${yaffleEnv} (${yaffleEnvSource})`,
    `node_env: ${process.env.NODE_ENV ?? "development"}`,
    `process_role: ${input.processRole}`,
    `bind: ${input.hostname}:${input.port}`,
    `pid: ${process.pid}`,
    `cwd: ${process.cwd()}`,
    `database: ${describeDatabase(process.env.DATABASE_URL)}`,
    `otel: ${otelEndpoint || "disabled"}${otelDataset ? ` dataset=${otelDataset}` : ""}`,
    `runner_mode: ${runnerMode}`,
    `warm_runner_auto_launch: ${warmRunnerHybrid.autoLaunchEnabled ? `enabled max_runners_per_org=${warmRunnerHybrid.autoLaunchMaxRunnersPerOrg} max_slots=${warmRunnerHybrid.autoLaunchMaxSlots} grace=${warmRunnerHybrid.launchGraceMs}ms` : "disabled"}`,
    `warm_runner_burst: ${warmRunnerHybrid.burstEnabled ? `enabled after ${warmRunnerHybrid.burstAfterMs}ms` : "disabled"}`,
    `warm_runner_excluded_workspaces: ${warmRunnerHybrid.excludedWorkspacePaths.length > 0 ? warmRunnerHybrid.excludedWorkspacePaths.join(", ") : "none"}`,
    `scanner_mode: ${scannerMode}${scannerMode === "lambda" ? ` (${scannerDetail})` : ""}`,
    `scheduler: ${input.startSchedulerRole && !input.schedulerDisabled ? `enabled worker=${schedulerInfo.workerId ?? "pending"} leader=${schedulerInfo.isLeader} running=${schedulerInfo.isRunning}` : "disabled"}`,
    `local_first_gc: ${input.startSchedulerRole && !input.schedulerDisabled && localFirstGcInfo.running ? `enabled interval=${localFirstGcInfo.intervalMs ?? "unknown"}ms` : "disabled"}`,
    `job_worker: ${input.startJobWorkerRole ? `enabled worker=${jobWorkerInfo.workerId ?? "pending"} running=${jobWorkerInfo.running}` : "disabled"}`,
    `runner_api_url: ${process.env.YAFFLE_RUNNER_API_URL ?? "unset"}`,
    `tfc_api_host: ${process.env.YAFFLE_TFC_API_HOST ?? "unset"}`,
    `aws_region: ${process.env.AWS_REGION ?? "unset"}`,
  ]

  console.log(lines.map((line) => `[startup] ${line}`).join("\n"))

  log.info("Control plane startup summary", {
    yaffleEnv,
    yaffleEnvSource,
    nodeEnv: process.env.NODE_ENV ?? "development",
    processRole: input.processRole,
    hostname: input.hostname,
    port: input.port,
    pid: process.pid,
    cwd: process.cwd(),
    database: describeDatabase(process.env.DATABASE_URL),
    otelEndpoint: otelEndpoint || "disabled",
    otelDataset: otelDataset ?? undefined,
    runnerMode,
    warmRunnerAutoLaunchEnabled: warmRunnerHybrid.autoLaunchEnabled,
    warmRunnerAutoLaunchMaxSlots: warmRunnerHybrid.autoLaunchMaxSlots,
    warmRunnerAutoLaunchMaxRunnersPerOrg: warmRunnerHybrid.autoLaunchMaxRunnersPerOrg,
    warmRunnerLaunchGraceMs: warmRunnerHybrid.launchGraceMs,
    warmRunnerBurstEnabled: warmRunnerHybrid.burstEnabled,
    warmRunnerBurstAfterMs: warmRunnerHybrid.burstAfterMs,
    warmRunnerExcludedWorkspaces: warmRunnerHybrid.excludedWorkspacePaths,
    scannerMode,
    scannerDetail,
    schedulerEnabled: input.startSchedulerRole && !input.schedulerDisabled,
    schedulerWorkerId: schedulerInfo.workerId ?? undefined,
    schedulerIsLeader: schedulerInfo.isLeader,
    schedulerIsRunning: schedulerInfo.isRunning,
    schedulerElectionRunning: schedulerInfo.electionRunning,
    localFirstGcRunning: localFirstGcInfo.running,
    localFirstGcIntervalMs: localFirstGcInfo.intervalMs ?? undefined,
    jobWorkerEnabled: input.startJobWorkerRole,
    jobWorkerWorkerId: jobWorkerInfo.workerId ?? undefined,
    jobWorkerRunning: jobWorkerInfo.running,
    runnerApiUrl: process.env.YAFFLE_RUNNER_API_URL ?? undefined,
    tfcApiHost: process.env.YAFFLE_TFC_API_HOST ?? undefined,
    awsRegion: process.env.AWS_REGION ?? undefined,
  })
}

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
  startLocalFirstGcLoop()
  log.info("Local-first GC loop started")
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
app.route("/api/cloud", cloudCliRoute) // Account-backed CLI login and guest conversion
app.route("/api/cloud", cloudConvergeRoute) // Hosted manual converge entrypoint for paid-cloud CLI
app.route("/api", localFirstRoute) // Anonymous sessions, execution tokens, hosted output modules
app.route("/api/lifecycle", lifecycleRoute) // Activation/verification lifecycle orchestration
app.route("/api/runner", runnerRoute) // Runner worker API (claim, heartbeat, complete)
app.route("/api/scanner", scannerRoute) // Scanner worker API (claim, heartbeat, complete)
app.route("/api/internal/provider-discovery", providerDiscoveryRoute)
app.route("/api", healthRoute)

const port = Number(process.env.PORT ?? 3000)
const hostname = process.env.HOST ?? "0.0.0.0"

printStartupBanner({
  hostname,
  port,
  processRole,
  schedulerDisabled,
  startSchedulerRole,
  startJobWorkerRole,
})

log.info(`yaffle api listening on :${port}`, { port })

// Graceful shutdown
async function shutdown() {
  log.info("shutting down")
  if (startSchedulerRole && !schedulerDisabled) {
    stopLocalFirstGcLoop()
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
  hostname,
  fetch: app.fetch,
  // Disable Bun's default 10s idle timeout — SSE connections can be idle
  // for extended periods between events. Our own 30s heartbeat keeps
  // connections alive at the EventSource/proxy layer.
  idleTimeout: 0,
}
