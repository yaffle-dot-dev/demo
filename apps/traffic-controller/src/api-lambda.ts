import {
  trafficControllerApiCommandSchema,
  type TrafficControllerApiCommand,
  type TrafficControllerApiResponse,
} from "./contract.ts"
import {
  createEnsureRouteableDeploymentDeps,
  ensureRouteableDeployment,
} from "./commands/ensure-routeable-deployment.ts"
import {
  createEnsureLiveWebhookLeaseDeps,
  ensureLiveWebhookLease,
} from "./commands/ensure-live-webhook-lease.ts"
import { findOperationById } from "./db/queries/operations.ts"
import { createReconcileQueueClient } from "./reconcile-queue.ts"
import { forceFlushTelemetry, initTelemetry, logger, withSpan } from "./telemetry.ts"

interface LambdaHttpEvent {
  body?: string | null
}

interface LambdaHttpResponse {
  statusCode: number
  headers: Record<string, string>
  body: string
}

interface HandleApiCommandDeps {
  ensureRouteableDeployment: (
    command: Extract<TrafficControllerApiCommand, { command: "ensure_routeable_deployment" }>,
  ) => Promise<TrafficControllerApiResponse>
  ensureLiveWebhookLease: (
    command: Extract<TrafficControllerApiCommand, { command: "ensure_live_webhook_lease" }>,
  ) => Promise<TrafficControllerApiResponse>
  findOperationById: typeof findOperationById
}

const defaultDeps: HandleApiCommandDeps = {
  ensureRouteableDeployment: (command) => ensureRouteableDeployment(command, createEnsureRouteableDeploymentDeps(createReconcileQueueClient())),
  ensureLiveWebhookLease: (command) => ensureLiveWebhookLease(command, createEnsureLiveWebhookLeaseDeps(createReconcileQueueClient())),
  findOperationById,
}

function operationToApiResponse(result: Awaited<ReturnType<typeof findOperationById>>): TrafficControllerApiResponse {
  if (!result) {
    return {
      status: "rejected",
      code: "NOT_FOUND",
      message: "operation not found",
    }
  }

  return {
    status: "operation",
    operation: {
      operationId: result.id,
      operationType: result.operationType,
      status: result.status,
      resultCode: result.resultCode ?? undefined,
      resultMessage: result.resultMessage ?? undefined,
      leaseId: result.liveWebhookLeaseId ?? undefined,
      routeableDeploymentId: result.routeableDeploymentId ?? undefined,
      output: (result.output as Record<string, unknown> | null) ?? undefined,
    },
  }
}

export async function handleApiCommand(
  command: TrafficControllerApiCommand,
  deps: HandleApiCommandDeps = defaultDeps,
): Promise<TrafficControllerApiResponse> {
  switch (command.command) {
    case "ensure_routeable_deployment":
      return deps.ensureRouteableDeployment(command)
    case "get_operation":
      return operationToApiResponse(await deps.findOperationById(command.operationId))
    case "ensure_live_webhook_lease":
      return deps.ensureLiveWebhookLease(command)
  }
}

function extractInvokePayload(event: unknown): unknown {
  if (typeof event === "object" && event !== null && "body" in event) {
    const body = (event as LambdaHttpEvent).body
    if (typeof body === "string") {
      return JSON.parse(body)
    }

    if (body == null) {
      return {}
    }
  }

  return event
}

export async function handler(event: unknown): Promise<LambdaHttpResponse> {
  return handlerWithDeps(event)
}

export async function handlerWithDeps(
  event: unknown,
  deps: HandleApiCommandDeps = defaultDeps,
): Promise<LambdaHttpResponse> {
  await initTelemetry()
  let body: unknown

  try {
    body = extractInvokePayload(event)
  } catch {
    return {
      statusCode: 400,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        error: {
          code: "INVALID_JSON",
          message: "Request body must be valid JSON",
        },
      }),
    }
  }

  const parsed = trafficControllerApiCommandSchema.safeParse(body)
  if (!parsed.success) {
    logger.warn("traffic-controller api validation failed", {
      issueCount: parsed.error.issues.length,
    })
    return {
      statusCode: 400,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid traffic-controller command payload",
          details: parsed.error.issues,
        },
      }),
    }
  }

  try {
    const result = await withSpan(
      `traffic-controller.api.${parsed.data.command}`,
      {
        "traffic_controller.command": parsed.data.command,
      },
      () => handleApiCommand(parsed.data, deps),
    )
    const statusCode = result.status === "rejected"
      ? (result.code === "NOT_FOUND" ? 404 : result.code === "NOT_IMPLEMENTED" ? 501 : 400)
      : result.status === "operation"
        ? 200
        : 202

    logger.info("traffic-controller api command handled", {
      command: parsed.data.command,
      statusCode,
      status: result.status,
      operationId: result.status === "accepted"
        ? result.operationId
        : result.status === "operation"
          ? result.operation.operationId
          : undefined,
    })

    return {
      statusCode,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: result }),
    }
  } finally {
    await forceFlushTelemetry(`api:${parsed.data.command}`)
  }
}
