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
