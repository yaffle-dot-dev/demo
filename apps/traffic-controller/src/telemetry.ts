import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager"
import {
  context,
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  trace,
  SpanStatusCode,
} from "@opentelemetry/api"
import { SeverityNumber } from "@opentelemetry/api-logs"
import type { Logger as OTelLogger } from "@opentelemetry/api-logs"

const SERVICE_NAME = "yaffle-traffic-controller"
const SERVICE_VERSION = "0.0.1"

type FlushableProvider = {
  forceFlush?(): Promise<void>
}

const secretsClient = new SecretsManagerClient({})

let tracerProviderInstance: FlushableProvider | null = null
let loggerProviderInstance: FlushableProvider | null = null
let otelLogger: OTelLogger | null = null
let telemetryInitPromise: Promise<void> | null = null

async function getSecretString(secretIdEnv: string): Promise<string | null> {
  const secretId = process.env[secretIdEnv]?.trim()
  if (!secretId) {
    return null
  }

  const secret = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretId }))
  return secret.SecretString?.trim() || null
}

export function extractAxiomDataset(headers: string | undefined): string | null {
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

async function hydrateTelemetrySecrets(): Promise<void> {
  const [genericHeaders, tracesHeaders, logsHeaders] = await Promise.all([
    getSecretString("OTEL_EXPORTER_OTLP_HEADERS_SECRET_ARN"),
    getSecretString("OTEL_EXPORTER_OTLP_TRACES_HEADERS_SECRET_ARN"),
    getSecretString("OTEL_EXPORTER_OTLP_LOGS_HEADERS_SECRET_ARN"),
  ])

  if (genericHeaders) {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = genericHeaders
  }
  if (tracesHeaders) {
    process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = tracesHeaders
  }
  if (logsHeaders) {
    process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = logsHeaders
  }
}

export async function initTelemetry(): Promise<void> {
  telemetryInitPromise ??= (async () => {
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    if (!endpoint) {
      return
    }

    await hydrateTelemetrySecrets()

    const tracesDataset =
      extractAxiomDataset(process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS) ??
      extractAxiomDataset(process.env.OTEL_EXPORTER_OTLP_HEADERS)
    const logsDataset =
      extractAxiomDataset(process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS) ??
      extractAxiomDataset(process.env.OTEL_EXPORTER_OTLP_HEADERS)

    if (tracerProviderInstance || loggerProviderInstance) {
      return
    }

    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN)

    const { resourceFromAttributes } = await import("@opentelemetry/resources")
    const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION, SEMRESATTRS_DEPLOYMENT_ENVIRONMENT } =
      await import("@opentelemetry/semantic-conventions")
    const { BasicTracerProvider, BatchSpanProcessor } =
      await import("@opentelemetry/sdk-trace-base")
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-proto")
    const { LoggerProvider, BatchLogRecordProcessor } = await import("@opentelemetry/sdk-logs")
    const { OTLPLogExporter } = await import("@opentelemetry/exporter-logs-otlp-proto")

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
      [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: process.env.YAFFLE_ENV ?? "development",
    })

    const tracerProvider = new BasicTracerProvider({
      resource,
      spanProcessors: [
        new BatchSpanProcessor(new OTLPTraceExporter(), {
          scheduledDelayMillis: 500,
          maxQueueSize: 2048,
          maxExportBatchSize: 256,
        }),
      ],
    })
    trace.setGlobalTracerProvider(tracerProvider)
    tracerProviderInstance = tracerProvider

    const loggerProvider = new LoggerProvider({
      resource,
      processors: [
        new BatchLogRecordProcessor(new OTLPLogExporter(), {
          scheduledDelayMillis: 500,
          maxQueueSize: 2048,
          maxExportBatchSize: 256,
        }),
      ],
    })
    loggerProviderInstance = loggerProvider
    otelLogger = loggerProvider.getLogger(SERVICE_NAME, SERVICE_VERSION)

    console.log(
      `[traffic-controller telemetry] initialized endpoint=${endpoint} traces_dataset=${tracesDataset ?? "unknown"} logs_dataset=${logsDataset ?? "unknown"}`,
    )
  })()

  return telemetryInitPromise
}

export async function forceFlushTelemetry(reason: string): Promise<void> {
  const results = await Promise.allSettled([
    tracerProviderInstance?.forceFlush?.(),
    loggerProviderInstance?.forceFlush?.(),
  ])
  const failures = results.filter((result) => result.status === "rejected")
  if (failures.length > 0) {
    console.warn(`[traffic-controller telemetry] force flush failed for ${reason}`)
  }
}

function emitLog(
  severityText: "INFO" | "WARN" | "ERROR",
  body: string,
  attributes?: Record<string, unknown>,
): void {
  const prefix = `[traffic-controller] ${severityText.toLowerCase()}`
  if (severityText === "ERROR") {
    console.error(`${prefix}: ${body}`, attributes ?? {})
  } else if (severityText === "WARN") {
    console.warn(`${prefix}: ${body}`, attributes ?? {})
  } else {
    console.log(`${prefix}: ${body}`, attributes ?? {})
  }

  if (!otelLogger) {
    return
  }

  const severityNumber =
    severityText === "ERROR"
      ? SeverityNumber.ERROR
      : severityText === "WARN"
        ? SeverityNumber.WARN
        : SeverityNumber.INFO

  try {
    const normalizedAttributes = attributes
      ? Object.fromEntries(
          Object.entries(attributes).map(([key, value]) => {
            if (
              typeof value === "string" ||
              typeof value === "number" ||
              typeof value === "boolean" ||
              value == null
            ) {
              return [key, value]
            }

            return [key, JSON.stringify(value)]
          }),
        )
      : undefined

    otelLogger.emit({
      body,
      severityText,
      severityNumber,
      attributes: normalizedAttributes,
      context: context.active(),
    })
  } catch (error) {
    console.warn(
      `[traffic-controller telemetry] failed to emit log: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export const logger = {
  info(body: string, attributes?: Record<string, unknown>): void {
    emitLog("INFO", body, attributes)
  },
  warn(body: string, attributes?: Record<string, unknown>): void {
    emitLog("WARN", body, attributes)
  },
  error(body: string, attributes?: Record<string, unknown>): void {
    emitLog("ERROR", body, attributes)
  },
}

export const tracer = trace.getTracer(SERVICE_NAME, SERVICE_VERSION)

export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const filtered = Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined),
  )

  return tracer.startActiveSpan(name, async (span) => {
    span.setAttributes(filtered)
    try {
      const result = await fn()
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)))
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      })
      throw error
    } finally {
      span.end()
    }
  })
}
