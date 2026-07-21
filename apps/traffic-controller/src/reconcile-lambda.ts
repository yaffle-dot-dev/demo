import { findOperationById } from "./db/queries/operations.ts"
import { reconcileLiveWebhookLease } from "./reconcile-live-webhook-lease.ts"
import { reconcileRouteableDeployment } from "./reconcile-routeable-deployment.ts"
import { trafficControllerReconcileCommandSchema } from "./contract.ts"
import { forceFlushTelemetry, initTelemetry, logger, withSpan } from "./telemetry.ts"

interface ReconcileResult {
  ok: boolean
  processedCount?: number
}

interface SqsRecord {
  body: string
}

interface SqsEvent {
  Records: SqsRecord[]
}

function isSqsEvent(event: unknown): event is SqsEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    "Records" in event &&
    Array.isArray((event as { Records?: unknown }).Records)
  )
}

export async function handleReconcileCommand(
  body: unknown,
  deps: {
    findOperationById: typeof findOperationById
    reconcileRouteableDeployment: typeof reconcileRouteableDeployment
    reconcileLiveWebhookLease: typeof reconcileLiveWebhookLease
  } = {
    findOperationById,
    reconcileRouteableDeployment,
    reconcileLiveWebhookLease,
  },
): Promise<ReconcileResult> {
  const parsed = trafficControllerReconcileCommandSchema.parse(body)

  return withSpan(
    `traffic-controller.reconcile.${parsed.command}`,
    {
      "traffic_controller.command": parsed.command,
    },
    async () => {
      switch (parsed.command) {
        case "reconcile_routeable_deployment": {
          const operation = await deps.findOperationById(parsed.operationId)
          if (!operation) {
            throw new Error(`operation ${parsed.operationId} not found`)
          }

          const input = operation.input
          if (
            typeof input !== "object" ||
            input === null ||
            (input as Record<string, unknown>).command !== "ensure_routeable_deployment"
          ) {
            throw new Error(
              `operation ${parsed.operationId} does not contain ensure_routeable_deployment input`,
            )
          }

          await deps.reconcileRouteableDeployment({
            operationId: parsed.operationId,
            deploymentId: parsed.routeableDeploymentId,
            command: input as {
              deploymentId: string
              prNumber: number
              environmentName: string
              environmentKind: "transient" | "named"
              ownerGithubUserId: number
              ownerGithubLogin: string
              receiverUrl: string
              receiverKind: "github_webhook"
              desiredState: "active" | "inactive" | "destroyed"
            },
          })

          logger.info("traffic-controller reconciled routeable deployment", {
            operationId: parsed.operationId,
            routeableDeploymentId: parsed.routeableDeploymentId,
          })

          return { ok: true }
        }
        case "reconcile_live_webhook_lease":
          await deps.reconcileLiveWebhookLease({
            operationId: parsed.operationId,
            leaseId: parsed.leaseId,
          })
          logger.info("traffic-controller reconciled live webhook lease", {
            operationId: parsed.operationId,
            leaseId: parsed.leaseId,
          })
          return { ok: true }
        case "sweep_drift":
          throw new Error("sweep_drift is not implemented yet")
      }
    },
  )
}

export async function handler(event: unknown): Promise<ReconcileResult> {
  return handlerWithDeps(event)
}

export async function handlerWithDeps(
  event: unknown,
  deps: {
    findOperationById: typeof findOperationById
    reconcileRouteableDeployment: typeof reconcileRouteableDeployment
    reconcileLiveWebhookLease: typeof reconcileLiveWebhookLease
  } = {
    findOperationById,
    reconcileRouteableDeployment,
    reconcileLiveWebhookLease,
  },
): Promise<ReconcileResult> {
  await initTelemetry()
  if (isSqsEvent(event)) {
    try {
      for (const record of event.Records) {
        let parsedBody: unknown
        try {
          parsedBody = JSON.parse(record.body)
        } catch {
          throw new Error("Invalid reconcile payload: SQS record body must be valid JSON")
        }

        const parsedRecord = trafficControllerReconcileCommandSchema.safeParse(parsedBody)
        if (!parsedRecord.success) {
          throw new Error(
            `Invalid reconcile payload: ${parsedRecord.error.issues[0]?.message ?? "unknown error"}`,
          )
        }

        await handleReconcileCommand(parsedRecord.data, deps)
      }

      logger.info("traffic-controller processed reconcile batch", {
        processedCount: event.Records.length,
      })

      return {
        ok: true,
        processedCount: event.Records.length,
      }
    } finally {
      await forceFlushTelemetry("reconcile-batch")
    }
  }

  const parsed = trafficControllerReconcileCommandSchema.safeParse(event)
  if (!parsed.success) {
    logger.warn("traffic-controller reconcile validation failed", {
      issue: parsed.error.issues[0]?.message ?? "unknown error",
    })
    throw new Error(
      `Invalid reconcile payload: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
    )
  }

  try {
    return await handleReconcileCommand(parsed.data, deps)
  } finally {
    await forceFlushTelemetry(`reconcile:${parsed.data.command}`)
  }
}
