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

    // Logs
    const logExporter = new OTLPLogExporter()
    const logProvider = new LoggerProvider({
      resource,
      logRecordProcessors: [new BatchLogRecordProcessor(logExporter)],
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
 * Get the tracer. Returns the global OTel tracer (no-op if SDK not initialized).
 */
export const tracer = trace.getTracer(SERVICE_NAME, SERVICE_VERSION)

/**
 * Get the meter. Returns the global OTel meter (no-op if SDK not initialized).
 */
export const meter = metrics.getMeter(SERVICE_NAME, SERVICE_VERSION)

export { context, SpanStatusCode }
export type { Span, SpanOptions, Attributes }

// ---------------------------------------------------------------------------
// Metrics instances (from the Linear issue spec)
// ---------------------------------------------------------------------------

/** Counter: webhook events received, by event type. */
export const webhookReceivedCounter = meter.createCounter("yaffle.webhook.received", {
  description: "Webhook events received",
})

/** Histogram: terraform run duration in ms, by command/workspace. */
export const runDurationHistogram = meter.createHistogram("yaffle.run.duration", {
  description: "Terraform run duration in milliseconds",
  unit: "ms",
})

/** Counter: terraform run results, by command/success/failure. */
export const runResultCounter = meter.createCounter("yaffle.run.result", {
  description: "Terraform run results",
})

/** Counter: config load errors. */
export const configLoadErrorCounter = meter.createCounter("yaffle.config.load.errors", {
  description: "Config load errors",
})

/** Counter: GitHub API errors, by endpoint. */
export const githubApiErrorCounter = meter.createCounter("yaffle.github.api.errors", {
  description: "GitHub API errors",
})

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
 * Graceful shutdown -- flush all pending telemetry.
 */
export async function shutdownTelemetry(): Promise<void> {
  await Promise.allSettled([
    tracerProviderInstance?.shutdown(),
    meterProviderInstance?.shutdown(),
    loggerProviderInstance?.shutdown(),
  ])
}
