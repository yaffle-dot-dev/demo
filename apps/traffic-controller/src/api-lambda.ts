import {
  trafficControllerApiCommandSchema,
  type TrafficControllerApiCommand,
  type TrafficControllerApiResponse,
} from "./contract.ts"
import {
  createEnsureRouteableDeploymentDeps,
  ensureRouteableDeployment,
} from "./commands/ensure-routeable-deployment.ts"
import { findOperationById } from "./db/queries/operations.ts"
import { createReconcileQueueClient } from "./reconcile-queue.ts"

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
  findOperationById: typeof findOperationById
}

const defaultDeps: HandleApiCommandDeps = {
  ensureRouteableDeployment: (command) => ensureRouteableDeployment(
    command,
    createEnsureRouteableDeploymentDeps(createReconcileQueueClient()),
  ),
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
      return {
        status: "rejected",
        code: "NOT_IMPLEMENTED",
        message: "ensure_live_webhook_lease is not implemented yet",
      }
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

  const result = await handleApiCommand(parsed.data)
  const statusCode = result.status === "rejected"
    ? (result.code === "NOT_FOUND" ? 404 : result.code === "NOT_IMPLEMENTED" ? 501 : 400)
    : result.status === "operation"
      ? 200
      : 202

  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data: result }),
  }
}
