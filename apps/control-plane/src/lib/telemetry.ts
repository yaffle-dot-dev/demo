import { trace, metrics, context, SpanStatusCode } from "@opentelemetry/api"
import type { Span, SpanOptions, Attributes } from "@opentelemetry/api"
import { SeverityNumber } from "@opentelemetry/api-logs"
import type { Logger as OTelLogger } from "@opentelemetry/api-logs"

const SERVICE_NAME = "yaffle-api"
const SERVICE_VERSION = "0.0.1"

// ---------------------------------------------------------------------------
// SDK providers -- set by initTelemetry(), null in tests / when OTLP is off
// ---------------------------------------------------------------------------

let tracerProviderInstance: { shutdown(): Promise<void> } | null = null
let meterProviderInstance: { shutdown(): Promise<void> } | null = null
let loggerProviderInstance: { shutdown(): Promise<void> } | null = null
let otelLogger: OTelLogger | null = null

/**
 * Initialize the OTel SDK with OTLP exporters.
 * Call this once at app startup (before handling requests).
 * Safe to skip in tests -- everything degrades to no-ops.
 */
export async function initTelemetry(): Promise<void> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (!endpoint) {
    console.log("[telemetry] OTEL_EXPORTER_OTLP_ENDPOINT not set, telemetry disabled")
    return
  }

  try {
    const { resourceFromAttributes } = await import("@opentelemetry/resources")
    const {
      ATTR_SERVICE_NAME,
      ATTR_SERVICE_VERSION,
      SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
    } = await import("@opentelemetry/semantic-conventions")
    const { BasicTracerProvider, BatchSpanProcessor } = await import("@opentelemetry/sdk-trace-base")
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-proto")
    const { MeterProvider, PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics")
    const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-proto")
    const { LoggerProvider, BatchLogRecordProcessor } = await import("@opentelemetry/sdk-logs")
    const { OTLPLogExporter } = await import("@opentelemetry/exporter-logs-otlp-proto")

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
      [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: process.env.YAFFLE_ENV ?? "development",
    })

    // Tracing
    const traceExporter = new OTLPTraceExporter()
    const tracerProvider = new BasicTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(traceExporter)],
    })
    // Register as global tracer provider via the API
    trace.setGlobalTracerProvider(tracerProvider)
    tracerProviderInstance = tracerProvider

    // Metrics
    const metricExporter = new OTLPMetricExporter()
    const meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: metricExporter,
          exportIntervalMillis: 30_000,
        }),
      ],
    })
    metrics.setGlobalMeterProvider(meterProvider)
    meterProviderInstance = meterProvider
    resetMeter()

    // Logs
    const logExporter = new OTLPLogExporter()
    const logProvider = new LoggerProvider({
      resource,
      processors: [new BatchLogRecordProcessor(logExporter)],
    })
    loggerProviderInstance = logProvider
    otelLogger = logProvider.getLogger(SERVICE_NAME, SERVICE_VERSION)

    console.log(`[telemetry] initialized: endpoint=${endpoint}`)
  } catch (err) {
    console.warn("[telemetry] failed to initialize OTel SDK:", err)
  }
}

// ---------------------------------------------------------------------------
// Public API -- always safe to call, even without SDK init
// ---------------------------------------------------------------------------

/**
 * Get the tracer. The OTel API proxies through to the real provider
 * even when obtained before initTelemetry() is called.
 */
export const tracer = trace.getTracer(SERVICE_NAME, SERVICE_VERSION)

export { context, SpanStatusCode }
export type { Span, SpanOptions, Attributes }

// ---------------------------------------------------------------------------
// Metrics -- lazy getters so instruments bind to the real MeterProvider
// ---------------------------------------------------------------------------
//
// Unlike the tracer, meters and their instruments obtained before
// setGlobalMeterProvider() are permanently no-op. We use a lazy pattern:
// the first call after initTelemetry() creates real instruments; before
// that, calls go to no-op counters/histograms (harmless).

let _meter: ReturnType<typeof metrics.getMeter> | null = null
function getMeter(): ReturnType<typeof metrics.getMeter> {
  if (!_meter) _meter = metrics.getMeter(SERVICE_NAME, SERVICE_VERSION)
  return _meter
}

// Reset cached meter after provider registration so instruments bind correctly
function resetMeter(): void {
  _meter = null
  _webhookReceivedCounter = null
  _runDurationHistogram = null
  _runResultCounter = null
  _configLoadErrorCounter = null
  _githubApiErrorCounter = null
  _httpRequestDuration = null
  _httpRequestCounter = null
  _githubApiDuration = null
  _authDuration = null
  _authCounter = null
  _runQueueTime = null
  _sseSnapshotDuration = null
  _ssePayloadBytes = null
  _sseMessagesSent = null
  _sseMessagesDeduped = null
  _sseConnectionsActive = null
  _sseEventsEmitted = null
  // Scheduler metrics
  _schedulerJobsClaimedCounter = null
  _schedulerJobsBlockedCounter = null
  _schedulerSpawnAttemptsCounter = null
  _schedulerSpawnSuppressedCounter = null
  _schedulerSpawnFailuresCounter = null
  _schedulerPollOverlapCounter = null
  _schedulerQueueToSpawnHistogram = null
  _schedulerActiveJobsGauge = null
  _schedulerQueuedJobsGauge = null
  _schedulerPollDuration = null
  _schedulerGroupsQueuedGauge = null
  _schedulerPollGroupsQueried = null
  _schedulerPollJobsFetched = null
  _schedulerSkipLockedMisses = null
  // Connection requirements metrics
  _connectionRequirementsDuration = null
  _connectionRequirementsDeploymentsScanned = null
  _connectionRequirementsProvidersScanned = null
  _connectionRequirementsProviderCache = null
  // Provisioning metrics
  _provisioningAttemptsCounter = null
  _provisioningDurationHistogram = null
  _provisioningFailuresCounter = null
  _provisioningPermanentFailuresCounter = null
  // Job lifecycle metrics
  _jobQueueWaitHistogram = null
  _jobRunDurationHistogram = null
  _jobHeartbeatsCounter = null
  _jobStateTransitionsCounter = null
  // Runner execution metrics
  _runnerTasksStartedCounter = null
  _runnerDispatchDurationHistogram = null
  _runnerStartupDurationHistogram = null
  _runnerFirstOutputDurationHistogram = null
  _runnerTaskDurationHistogram = null
  _runnerWarmRunnersActiveGauge = null
  _runnerWarmSlotsActiveGauge = null
  _runnerWarmRunnersActiveValue = 0
  _runnerWarmSlotsActiveValue = 0
}

let _webhookReceivedCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null
/** Counter: webhook events received, by event type. */
export function getWebhookReceivedCounter(): typeof _webhookReceivedCounter & {} {
  if (!_webhookReceivedCounter) {
    _webhookReceivedCounter = getMeter().createCounter("yaffle.webhook.received", {
      description: "Webhook events received",
    })
  }
  return _webhookReceivedCounter
}

let _runDurationHistogram: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]> | null = null
/** Histogram: terraform run duration in ms, by command/workspace. */
export function getRunDurationHistogram(): typeof _runDurationHistogram & {} {
  if (!_runDurationHistogram) {
    _runDurationHistogram = getMeter().createHistogram("yaffle.run.duration", {
      description: "Terraform run duration in milliseconds",
      unit: "ms",
    })
  }
  return _runDurationHistogram
}

let _runResultCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null
/** Counter: terraform run results, by command/success/failure. */
export function getRunResultCounter(): typeof _runResultCounter & {} {
  if (!_runResultCounter) {
    _runResultCounter = getMeter().createCounter("yaffle.run.result", {
      description: "Terraform run results",
    })
  }
  return _runResultCounter
}

let _configLoadErrorCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null
/** Counter: config load errors. */
export function getConfigLoadErrorCounter(): typeof _configLoadErrorCounter & {} {
  if (!_configLoadErrorCounter) {
    _configLoadErrorCounter = getMeter().createCounter("yaffle.config.load.errors", {
      description: "Config load errors",
    })
  }
  return _configLoadErrorCounter
}

let _githubApiErrorCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null
/** Counter: GitHub API errors, by endpoint. */
export function getGithubApiErrorCounter(): typeof _githubApiErrorCounter & {} {
  if (!_githubApiErrorCounter) {
    _githubApiErrorCounter = getMeter().createCounter("yaffle.github.api.errors", {
      description: "GitHub API errors",
    })
  }
  return _githubApiErrorCounter
}

let _httpRequestDuration: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]> | null = null
/** Histogram: HTTP request duration in ms, by method/route/status. */
export function getHttpRequestDurationHistogram(): typeof _httpRequestDuration & {} {
  if (!_httpRequestDuration) {
    _httpRequestDuration = getMeter().createHistogram("yaffle.http.request.duration", {
      description: "HTTP request duration in milliseconds",
      unit: "ms",
    })
  }
  return _httpRequestDuration
}

let _httpRequestCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null
/** Counter: HTTP requests, by method/route/status. */
export function getHttpRequestCounter(): typeof _httpRequestCounter & {} {
  if (!_httpRequestCounter) {
    _httpRequestCounter = getMeter().createCounter("yaffle.http.requests", {
      description: "HTTP requests",
    })
  }
  return _httpRequestCounter
}

let _githubApiDuration: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]> | null = null
/** Histogram: GitHub API call duration in ms, by endpoint. */
export function getGithubApiDurationHistogram(): typeof _githubApiDuration & {} {
  if (!_githubApiDuration) {
    _githubApiDuration = getMeter().createHistogram("yaffle.github.api.duration", {
      description: "GitHub API call duration in milliseconds",
      unit: "ms",
    })
  }
  return _githubApiDuration
}

let _authDuration: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]> | null = null
/** Histogram: Auth operation duration in ms. */
export function getAuthDurationHistogram(): typeof _authDuration & {} {
  if (!_authDuration) {
    _authDuration = getMeter().createHistogram("yaffle.auth.duration", {
      description: "Auth operation duration in milliseconds",
      unit: "ms",
    })
  }
  return _authDuration
}

let _authCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null
/** Counter: Auth operations, by operation/result. */
export function getAuthCounter(): typeof _authCounter & {} {
  if (!_authCounter) {
    _authCounter = getMeter().createCounter("yaffle.auth.operations", {
      description: "Auth operations",
    })
  }
  return _authCounter
}

let _runQueueTime: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]> | null = null
/** Histogram: Time from run creation to start in ms. */
export function getRunQueueTimeHistogram(): typeof _runQueueTime & {} {
  if (!_runQueueTime) {
    _runQueueTime = getMeter().createHistogram("yaffle.run.queue_time", {
      description: "Time from run creation to execution start in milliseconds",
      unit: "ms",
    })
  }
  return _runQueueTime
}

// ---------------------------------------------------------------------------
// SSE metrics (see docs/sse-streaming.md Decision 2)
// ---------------------------------------------------------------------------

let _sseSnapshotDuration: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]> | null = null
/** Histogram: SSE snapshot query duration in ms, by stream type. */
export function getSseSnapshotDurationHistogram(): typeof _sseSnapshotDuration & {} {
  if (!_sseSnapshotDuration) {
    _sseSnapshotDuration = getMeter().createHistogram("yaffle.sse.snapshot.duration", {
      description: "SSE snapshot query duration in milliseconds",
      unit: "ms",
    })
  }
  return _sseSnapshotDuration
}

let _ssePayloadBytes: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]> | null = null
/** Histogram: SSE payload size in bytes. */
export function getSsePayloadBytesHistogram(): typeof _ssePayloadBytes & {} {
  if (!_ssePayloadBytes) {
    _ssePayloadBytes = getMeter().createHistogram("yaffle.sse.payload.bytes", {
      description: "SSE payload size in bytes",
      unit: "By",
    })
  }
  return _ssePayloadBytes
}

let _sseMessagesSent: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null
/** Counter: SSE messages sent, by type (snapshot/heartbeat). */
export function getSseMessagesSentCounter(): typeof _sseMessagesSent & {} {
  if (!_sseMessagesSent) {
    _sseMessagesSent = getMeter().createCounter("yaffle.sse.messages.sent", {
      description: "SSE messages sent",
    })
  }
  return _sseMessagesSent
}

let _sseMessagesDeduped: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null
/** Counter: SSE messages deduped (payload unchanged). */
export function getSseMessagesDedupedCounter(): typeof _sseMessagesDeduped & {} {
  if (!_sseMessagesDeduped) {
    _sseMessagesDeduped = getMeter().createCounter("yaffle.sse.messages.deduped", {
      description: "SSE messages skipped due to unchanged payload",
    })
  }
  return _sseMessagesDeduped
}

let _sseConnectionsActive: ReturnType<ReturnType<typeof metrics.getMeter>["createUpDownCounter"]> | null = null
/** UpDownCounter: active SSE connections (gauge-like). */
export function getSseConnectionsActiveCounter(): typeof _sseConnectionsActive & {} {
  if (!_sseConnectionsActive) {
    _sseConnectionsActive = getMeter().createUpDownCounter("yaffle.sse.connections.active", {
      description: "Number of active SSE connections",
    })
  }
  return _sseConnectionsActive
}

let _sseEventsEmitted: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null
/** Counter: events emitted on the event bus, by type. */
export function getSseEventsEmittedCounter(): typeof _sseEventsEmitted & {} {
  if (!_sseEventsEmitted) {
    _sseEventsEmitted = getMeter().createCounter("yaffle.sse.events.emitted", {
      description: "Events emitted on the internal event bus",
    })
  }
  return _sseEventsEmitted
}

// ---------------------------------------------------------------------------
// Scheduler metrics
// ---------------------------------------------------------------------------

let _schedulerJobsClaimedCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null
/** Counter: jobs claimed by the scheduler for dispatch. */
export function getSchedulerJobsClaimedCounter(): typeof _schedulerJobsClaimedCounter & {} {
  if (!_schedulerJobsClaimedCounter) {
    _schedulerJobsClaimedCounter = getMeter().createCounter("yaffle.scheduler.jobs.claimed", {
      description: "Jobs claimed by scheduler for dispatch",
    })
  }
  return _schedulerJobsClaimedCounter
}

let _schedulerJobsBlockedCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null
/** Counter: jobs blocked due to concurrency limits, by reason (global_limit, group_limit). */
export function getSchedulerJobsBlockedCounter(): typeof _schedulerJobsBlockedCounter & {} {
  if (!_schedulerJobsBlockedCounter) {
    _schedulerJobsBlockedCounter = getMeter().createCounter("yaffle.scheduler.jobs.blocked", {
      description: "Jobs blocked due to concurrency limits",
    })
  }
  return _schedulerJobsBlockedCounter
}

let _schedulerSpawnAttemptsCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null
/** Counter: worker spawn attempts initiated by the scheduler. */
export function getSchedulerSpawnAttemptsCounter(): typeof _schedulerSpawnAttemptsCounter & {} {
  if (!_schedulerSpawnAttemptsCounter) {
    _schedulerSpawnAttemptsCounter = getMeter().createCounter("yaffle.scheduler.spawn.attempts", {
      description: "Worker spawn attempts initiated by the scheduler",
    })
  }
  return _schedulerSpawnAttemptsCounter
}

let _schedulerSpawnSuppressedCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null
/** Counter: jobs skipped by the scheduler before spawn, by reason. */
export function getSchedulerSpawnSuppressedCounter(): typeof _schedulerSpawnSuppressedCounter & {} {
  if (!_schedulerSpawnSuppressedCounter) {
    _schedulerSpawnSuppressedCounter = getMeter().createCounter("yaffle.scheduler.spawn.suppressed", {
      description: "Jobs skipped by the scheduler before spawn",
    })
  }
  return _schedulerSpawnSuppressedCounter
}

let _schedulerSpawnFailuresCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null
/** Counter: scheduler spawn failures, by reason. */
export function getSchedulerSpawnFailuresCounter(): typeof _schedulerSpawnFailuresCounter & {} {
  if (!_schedulerSpawnFailuresCounter) {
    _schedulerSpawnFailuresCounter = getMeter().createCounter("yaffle.scheduler.spawn.failures", {
      description: "Scheduler spawn failures",
    })
  }
  return _schedulerSpawnFailuresCounter
}

let _schedulerPollOverlapCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null
/** Counter: scheduler poll cycles that started while another poll was already in flight. */
export function getSchedulerPollOverlapCounter(): typeof _schedulerPollOverlapCounter & {} {
  if (!_schedulerPollOverlapCounter) {
    _schedulerPollOverlapCounter = getMeter().createCounter("yaffle.scheduler.poll.overlap", {
      description: "Scheduler poll cycles that overlapped with an in-flight poll",
    })
  }
  return _schedulerPollOverlapCounter
}

let _schedulerQueueToSpawnHistogram: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]> | null = null
/** Histogram: time from queueing to scheduler spawn attempt in ms. */
export function getSchedulerQueueToSpawnHistogram(): typeof _schedulerQueueToSpawnHistogram & {} {
  if (!_schedulerQueueToSpawnHistogram) {
    _schedulerQueueToSpawnHistogram = getMeter().createHistogram("yaffle.scheduler.queue_to_spawn", {
      description: "Time from job queueing to scheduler spawn attempt in milliseconds",
      unit: "ms",
    })
  }
  return _schedulerQueueToSpawnHistogram
}

let _schedulerActiveJobsGauge: ReturnType<ReturnType<typeof metrics.getMeter>["createObservableGauge"]> | null = null
let _schedulerActiveJobsValue = 0
/** Observable gauge: current number of active (running) jobs. */
export function getSchedulerActiveJobsGauge(): typeof _schedulerActiveJobsGauge & {} {
  if (!_schedulerActiveJobsGauge) {
    _schedulerActiveJobsGauge = getMeter().createObservableGauge("yaffle.scheduler.jobs.active", {
      description: "Current number of active jobs (running)",
    })
    _schedulerActiveJobsGauge.addCallback((result) => {
      result.observe(_schedulerActiveJobsValue)
    })
  }
  return _schedulerActiveJobsGauge
}

/** Update the active jobs gauge value. */
export function setSchedulerActiveJobsValue(count: number): void {
  _schedulerActiveJobsValue = count
  // Ensure gauge is initialized
  getSchedulerActiveJobsGauge()
}

let _schedulerQueuedJobsGauge: ReturnType<ReturnType<typeof metrics.getMeter>["createObservableGauge"]> | null = null
let _schedulerQueuedJobsValue = 0
/** Observable gauge: current number of queued jobs waiting for dispatch. */
export function getSchedulerQueuedJobsGauge(): typeof _schedulerQueuedJobsGauge & {} {
  if (!_schedulerQueuedJobsGauge) {
    _schedulerQueuedJobsGauge = getMeter().createObservableGauge("yaffle.scheduler.jobs.queued", {
      description: "Current number of jobs waiting in queue",
    })
    _schedulerQueuedJobsGauge.addCallback((result) => {
      result.observe(_schedulerQueuedJobsValue)
    })
  }
  return _schedulerQueuedJobsGauge
}

/** Update the queued jobs gauge value. */
export function setSchedulerQueuedJobsValue(count: number): void {
  _schedulerQueuedJobsValue = count
  // Ensure gauge is initialized
  getSchedulerQueuedJobsGauge()
}

let _schedulerPollDuration: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]> | null = null
/** Histogram: scheduler poll cycle duration in ms. */
export function getSchedulerPollDurationHistogram(): typeof _schedulerPollDuration & {} {
  if (!_schedulerPollDuration) {
    _schedulerPollDuration = getMeter().createHistogram("yaffle.scheduler.poll.duration", {
      description: "Scheduler poll cycle duration in ms",
      unit: "ms",
    })
  }
  return _schedulerPollDuration
}

let _schedulerGroupsQueuedGauge: ReturnType<ReturnType<typeof metrics.getMeter>["createObservableGauge"]> | null = null
let _schedulerGroupsQueuedValue = 0
/** Observable gauge: number of run groups with queued work. */
export function getSchedulerGroupsQueuedGauge(): typeof _schedulerGroupsQueuedGauge & {} {
  if (!_schedulerGroupsQueuedGauge) {
    _schedulerGroupsQueuedGauge = getMeter().createObservableGauge("yaffle.scheduler.groups.queued", {
      description: "Number of run groups with queued work",
    })
    _schedulerGroupsQueuedGauge.addCallback((result) => {
      result.observe(_schedulerGroupsQueuedValue)
    })
  }
  return _schedulerGroupsQueuedGauge
}

/** Update the groups queued gauge value. */
export function setSchedulerGroupsQueuedValue(count: number): void {
  _schedulerGroupsQueuedValue = count
  getSchedulerGroupsQueuedGauge()
}

let _schedulerPollGroupsQueried: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]> | null = null
/** Histogram: number of group queries per poll cycle. */
export function getSchedulerPollGroupsQueriedHistogram(): typeof _schedulerPollGroupsQueried & {} {
  if (!_schedulerPollGroupsQueried) {
    _schedulerPollGroupsQueried = getMeter().createHistogram("yaffle.scheduler.poll.groups_queried", {
      description: "Number of run group queries per scheduler poll cycle",
    })
  }
  return _schedulerPollGroupsQueried
}

let _schedulerPollJobsFetched: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]> | null = null
/** Histogram: total jobs fetched across all group queries per poll. */
export function getSchedulerPollJobsFetchedHistogram(): typeof _schedulerPollJobsFetched & {} {
  if (!_schedulerPollJobsFetched) {
    _schedulerPollJobsFetched = getMeter().createHistogram("yaffle.scheduler.poll.jobs_fetched", {
      description: "Total jobs fetched across all group queries per poll cycle",
    })
  }
  return _schedulerPollJobsFetched
}

let _schedulerSkipLockedMisses: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null
/** Counter: jobs we couldn't lock due to SKIP LOCKED (indicates contention). */
export function getSchedulerSkipLockedMissesCounter(): typeof _schedulerSkipLockedMisses & {} {
  if (!_schedulerSkipLockedMisses) {
    _schedulerSkipLockedMisses = getMeter().createCounter("yaffle.scheduler.claim.skip_locked_misses", {
      description: "Jobs skipped due to FOR UPDATE SKIP LOCKED (indicates contention)",
    })
  }
  return _schedulerSkipLockedMisses
}

// ---------------------------------------------------------------------------
// Connections requirements metrics
// ---------------------------------------------------------------------------

let _connectionRequirementsDuration: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]> | null = null
/** Histogram: connection requirement discovery duration in ms. */
export function getConnectionRequirementsDurationHistogram(): typeof _connectionRequirementsDuration & {} {
  if (!_connectionRequirementsDuration) {
    _connectionRequirementsDuration = getMeter().createHistogram("yaffle.connections.requirements.duration", {
      description: "Connection requirement discovery duration in milliseconds",
      unit: "ms",
    })
  }
  return _connectionRequirementsDuration
}

let _connectionRequirementsDeploymentsScanned: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]> | null = null
/** Histogram: number of deployments scanned during requirement discovery. */
export function getConnectionRequirementsDeploymentsScannedHistogram(): typeof _connectionRequirementsDeploymentsScanned & {} {
  if (!_connectionRequirementsDeploymentsScanned) {
    _connectionRequirementsDeploymentsScanned = getMeter().createHistogram("yaffle.connections.requirements.deployments_scanned", {
      description: "Deployments scanned during connection requirement discovery",
    })
  }
  return _connectionRequirementsDeploymentsScanned
}

let _connectionRequirementsProvidersScanned: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]> | null = null
/** Histogram: number of providers scanned during requirement discovery. */
export function getConnectionRequirementsProvidersScannedHistogram(): typeof _connectionRequirementsProvidersScanned & {} {
  if (!_connectionRequirementsProvidersScanned) {
    _connectionRequirementsProvidersScanned = getMeter().createHistogram("yaffle.connections.requirements.providers_scanned", {
      description: "Providers scanned during connection requirement discovery",
    })
  }
  return _connectionRequirementsProvidersScanned
}

let _connectionRequirementsProviderCache: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null
/** Counter: provider requirement cache outcomes (hit/miss/expired/evict). */
export function getConnectionRequirementsProviderCacheCounter(): typeof _connectionRequirementsProviderCache & {} {
  if (!_connectionRequirementsProviderCache) {
    _connectionRequirementsProviderCache = getMeter().createCounter("yaffle.connections.requirements.provider_cache", {
      description: "Provider requirement cache outcomes",
    })
  }
  return _connectionRequirementsProviderCache
}

// ---------------------------------------------------------------------------
// Org Provisioning metrics
// ---------------------------------------------------------------------------

let _provisioningAttemptsCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null
/** Counter: org provisioning attempts, by status (success/failure) and org. */
export function getProvisioningAttemptsCounter(): typeof _provisioningAttemptsCounter & {} {
  if (!_provisioningAttemptsCounter) {
    _provisioningAttemptsCounter = getMeter().createCounter("yaffle.provisioning.attempts", {
      description: "Org provisioning attempts",
    })
  }
  return _provisioningAttemptsCounter
}

let _provisioningDurationHistogram: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]> | null = null
/** Histogram: org provisioning duration in ms. */
export function getProvisioningDurationHistogram(): typeof _provisioningDurationHistogram & {} {
  if (!_provisioningDurationHistogram) {
    _provisioningDurationHistogram = getMeter().createHistogram("yaffle.provisioning.duration", {
      description: "Org provisioning duration in milliseconds",
      unit: "ms",
    })
  }
  return _provisioningDurationHistogram
}

let _provisioningFailuresCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null
/** Counter: org provisioning failures, by error type. */
export function getProvisioningFailuresCounter(): typeof _provisioningFailuresCounter & {} {
  if (!_provisioningFailuresCounter) {
    _provisioningFailuresCounter = getMeter().createCounter("yaffle.provisioning.failures", {
      description: "Org provisioning failures by error type",
    })
  }
  return _provisioningFailuresCounter
}

let _provisioningPermanentFailuresCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null
/** Counter: org provisioning permanent failures (max attempts exceeded). */
export function getProvisioningPermanentFailuresCounter(): typeof _provisioningPermanentFailuresCounter & {} {
  if (!_provisioningPermanentFailuresCounter) {
    _provisioningPermanentFailuresCounter = getMeter().createCounter("yaffle.provisioning.permanent_failures", {
      description: "Org provisioning permanent failures (max attempts exceeded)",
    })
  }
  return _provisioningPermanentFailuresCounter
}

// ---------------------------------------------------------------------------
// Job lifecycle metrics
// ---------------------------------------------------------------------------

let _jobQueueWaitHistogram: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]> | null = null
/** Histogram: time from job creation (queued) to claim (running) in ms. */
export function getJobQueueWaitHistogram(): typeof _jobQueueWaitHistogram & {} {
  if (!_jobQueueWaitHistogram) {
    _jobQueueWaitHistogram = getMeter().createHistogram("yaffle.job.queue_wait", {
      description: "Time from job creation to worker claim in milliseconds",
      unit: "ms",
    })
  }
  return _jobQueueWaitHistogram
}

let _jobRunDurationHistogram: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]> | null = null
/** Histogram: time from job start to completion in ms. */
export function getJobRunDurationHistogram(): typeof _jobRunDurationHistogram & {} {
  if (!_jobRunDurationHistogram) {
    _jobRunDurationHistogram = getMeter().createHistogram("yaffle.job.run_duration", {
      description: "Time from job start to completion in milliseconds",
      unit: "ms",
    })
  }
  return _jobRunDurationHistogram
}

let _jobHeartbeatsCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null
/** Counter: successful job heartbeats. */
export function getJobHeartbeatsCounter(): typeof _jobHeartbeatsCounter & {} {
  if (!_jobHeartbeatsCounter) {
    _jobHeartbeatsCounter = getMeter().createCounter("yaffle.job.heartbeats", {
      description: "Successful job heartbeat count",
    })
  }
  return _jobHeartbeatsCounter
}

let _jobStateTransitionsCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null
/** Counter: job state transitions, by from_state and to_state. */
export function getJobStateTransitionsCounter(): typeof _jobStateTransitionsCounter & {} {
  if (!_jobStateTransitionsCounter) {
    _jobStateTransitionsCounter = getMeter().createCounter("yaffle.job.state_transitions", {
      description: "Job state transition count",
    })
  }
  return _jobStateTransitionsCounter
}

// ---------------------------------------------------------------------------
// Runner execution metrics
// ---------------------------------------------------------------------------

let _runnerTasksStartedCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null
/** Counter: successful runner task/process starts. */
export function getRunnerTasksStartedCounter(): typeof _runnerTasksStartedCounter & {} {
  if (!_runnerTasksStartedCounter) {
    _runnerTasksStartedCounter = getMeter().createCounter("yaffle.runner.tasks.started", {
      description: "Successful runner task or process starts",
    })
  }
  return _runnerTasksStartedCounter
}

let _runnerDispatchDurationHistogram: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]> | null = null
/** Histogram: time spent in the scheduler spawn call in ms. */
export function getRunnerDispatchDurationHistogram(): typeof _runnerDispatchDurationHistogram & {} {
  if (!_runnerDispatchDurationHistogram) {
    _runnerDispatchDurationHistogram = getMeter().createHistogram("yaffle.runner.dispatch.duration", {
      description: "Time spent in the scheduler spawn call in milliseconds",
      unit: "ms",
    })
  }
  return _runnerDispatchDurationHistogram
}

let _runnerStartupDurationHistogram: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]> | null = null
/** Histogram: time from successful dispatch to worker claim in ms. */
export function getRunnerStartupDurationHistogram(): typeof _runnerStartupDurationHistogram & {} {
  if (!_runnerStartupDurationHistogram) {
    _runnerStartupDurationHistogram = getMeter().createHistogram("yaffle.runner.startup.duration", {
      description: "Time from successful dispatch to worker claim in milliseconds",
      unit: "ms",
    })
  }
  return _runnerStartupDurationHistogram
}

let _runnerFirstOutputDurationHistogram: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]> | null = null
/** Histogram: time from worker claim to first tofu output in ms. */
export function getRunnerFirstOutputDurationHistogram(): typeof _runnerFirstOutputDurationHistogram & {} {
  if (!_runnerFirstOutputDurationHistogram) {
    _runnerFirstOutputDurationHistogram = getMeter().createHistogram("yaffle.runner.first_output.duration", {
      description: "Time from worker claim to first tofu output in milliseconds",
      unit: "ms",
    })
  }
  return _runnerFirstOutputDurationHistogram
}

let _runnerTaskDurationHistogram: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]> | null = null
/** Histogram: proxy for runner task billed lifetime from dispatch to completion in ms. */
export function getRunnerTaskDurationHistogram(): typeof _runnerTaskDurationHistogram & {} {
  if (!_runnerTaskDurationHistogram) {
    _runnerTaskDurationHistogram = getMeter().createHistogram("yaffle.runner.task.duration", {
      description: "Proxy for runner task billed lifetime from dispatch to completion in milliseconds",
      unit: "ms",
    })
  }
  return _runnerTaskDurationHistogram
}

let _runnerWarmRunnersActiveGauge: ReturnType<ReturnType<typeof metrics.getMeter>["createObservableGauge"]> | null = null
let _runnerWarmRunnersActiveValue = 0
/** Observable gauge: current number of warm runners. Placeholder until warm mode ships. */
export function getRunnerWarmRunnersActiveGauge(): typeof _runnerWarmRunnersActiveGauge & {} {
  if (!_runnerWarmRunnersActiveGauge) {
    _runnerWarmRunnersActiveGauge = getMeter().createObservableGauge("yaffle.runner.warm.runners.active", {
      description: "Current number of warm runners",
    })
    _runnerWarmRunnersActiveGauge.addCallback((result) => {
      result.observe(_runnerWarmRunnersActiveValue)
    })
  }
  return _runnerWarmRunnersActiveGauge
}

export function setRunnerWarmRunnersActiveValue(count: number): void {
  _runnerWarmRunnersActiveValue = count
  getRunnerWarmRunnersActiveGauge()
}

let _runnerWarmSlotsActiveGauge: ReturnType<ReturnType<typeof metrics.getMeter>["createObservableGauge"]> | null = null
let _runnerWarmSlotsActiveValue = 0
/** Observable gauge: current number of active warm-runner slots. Placeholder until warm mode ships. */
export function getRunnerWarmSlotsActiveGauge(): typeof _runnerWarmSlotsActiveGauge & {} {
  if (!_runnerWarmSlotsActiveGauge) {
    _runnerWarmSlotsActiveGauge = getMeter().createObservableGauge("yaffle.runner.warm.slots.active", {
      description: "Current number of active warm-runner slots",
    })
    _runnerWarmSlotsActiveGauge.addCallback((result) => {
      result.observe(_runnerWarmSlotsActiveValue)
    })
  }
  return _runnerWarmSlotsActiveGauge
}

export function setRunnerWarmSlotsActiveValue(count: number): void {
  _runnerWarmSlotsActiveValue = count
  getRunnerWarmSlotsActiveGauge()
}

// ---------------------------------------------------------------------------
// Structured logging helper
// ---------------------------------------------------------------------------

/**
 * Structured logger that emits OTel log records (when SDK is initialized)
 * and always writes to console for local dev / container stdout.
 * Attributes are attached to the log record and correlated with the active
 * trace/span.
 */
export const logger = {
  info(message: string, attrs?: Attributes): void {
    emitLog(SeverityNumber.INFO, "INFO", message, attrs)
  },

  warn(message: string, attrs?: Attributes): void {
    emitLog(SeverityNumber.WARN, "WARN", message, attrs)
  },

  error(message: string, attrs?: Attributes): void {
    emitLog(SeverityNumber.ERROR, "ERROR", message, attrs)
  },

  debug(message: string, attrs?: Attributes): void {
    emitLog(SeverityNumber.DEBUG, "DEBUG", message, attrs)
  },
}

function emitLog(
  severityNumber: SeverityNumber,
  severityText: string,
  body: string,
  attrs?: Attributes,
): void {
  // Emit OTel log record if SDK is initialized
  if (otelLogger) {
    otelLogger.emit({
      severityNumber,
      severityText,
      body,
      attributes: attrs,
      context: context.active(),
    })
  }

  // Always write to console for local dev / container stdout
  const prefix = attrs
    ? `${JSON.stringify(attrs)} `
    : ""
  switch (severityText) {
    case "ERROR":
      console.error(`[${severityText}] ${prefix}${body}`)
      break
    case "WARN":
      console.warn(`[${severityText}] ${prefix}${body}`)
      break
    case "DEBUG":
      // Skip debug in console to reduce noise
      break
    default:
      console.log(`[${severityText}] ${prefix}${body}`)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Start a span, run a function within it, and end the span when done.
 * Sets span status to ERROR on exception and re-throws.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  opts?: SpanOptions,
): Promise<T> {
  return tracer.startActiveSpan(name, opts ?? {}, async (span) => {
    try {
      const result = await fn(span)
      span.end()
      return result
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      })
      span.recordException(err instanceof Error ? err : new Error(String(err)))
      span.end()
      throw err
    }
  })
}

/**
 * Wrap a database query with a span. Adds standard DB attributes.
 */
export async function withDbSpan<T>(
  operation: string,
  table: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now()
  return tracer.startActiveSpan(`db.${operation}`, async (span) => {
    span.setAttributes({
      "db.system": "postgresql",
      "db.operation": operation,
      "db.sql.table": table,
    })
    try {
      const result = await fn()
      span.setAttributes({ "db.duration_ms": Date.now() - start })
      span.end()
      return result
    } catch (err) {
      span.setAttributes({ "db.duration_ms": Date.now() - start })
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      })
      span.recordException(err instanceof Error ? err : new Error(String(err)))
      span.end()
      throw err
    }
  })
}

/**
 * Graceful shutdown -- flush all pending telemetry.
 */
export async function shutdownTelemetry(): Promise<void> {
  await Promise.allSettled([
    tracerProviderInstance?.shutdown(),
    meterProviderInstance?.shutdown(),
    loggerProviderInstance?.shutdown(),
  ])
}
