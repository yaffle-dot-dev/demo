import { z } from "zod"

export const routeableDeploymentStateSchema = z.enum(["active", "inactive", "destroyed"])

export const routeableDeploymentReceiverKindSchema = z.enum(["github_webhook"])

export const liveWebhookEventSchema = z.enum(["pull_request", "push", "installation_repositories"])

export const liveWebhookDesiredStateSchema = z.enum(["active", "absent"])

export const trafficControlOperationStatusSchema = z.enum([
  "accepted",
  "running",
  "succeeded",
  "failed",
  "rejected",
])

export const ensureRouteableDeploymentRequestSchema = z.object({
  command: z.literal("ensure_routeable_deployment"),
  requestId: z.string().min(1),
  deploymentId: z.string().min(1),
  prNumber: z.number().int().positive(),
  environmentName: z.string().min(1),
  environmentKind: z.enum(["transient", "named"]),
  ownerGithubUserId: z.number().int().positive(),
  ownerGithubLogin: z.string().min(1),
  receiverUrl: z.string().url(),
  receiverKind: routeableDeploymentReceiverKindSchema,
  desiredState: routeableDeploymentStateSchema,
})

export const liveWebhookLeaseScopeSchema = z
  .object({
    event: liveWebhookEventSchema,
    installationId: z.number().int().positive(),
    repositoryId: z.number().int().positive().optional(),
    action: z.string().min(1).optional(),
    pullRequestNumber: z.number().int().positive().optional(),
    ref: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    const repositoryRequired = value.event === "pull_request" || value.event === "push"
    if (repositoryRequired && value.repositoryId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "repositoryId is required for pull_request and push leases",
        path: ["repositoryId"],
      })
    }

    if (value.event === "installation_repositories" && value.repositoryId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "repositoryId is not allowed for installation_repositories leases",
        path: ["repositoryId"],
      })
    }
  })

export const ensureLiveWebhookLeaseRequestSchema = z.object({
  command: z.literal("ensure_live_webhook_lease"),
  requestId: z.string().min(1),
  actorGithubUserId: z.number().int().positive(),
  actorGithubLogin: z.string().min(1),
  prNumber: z.number().int().positive(),
  deploymentId: z.string().min(1),
  desiredState: liveWebhookDesiredStateSchema,
  scope: liveWebhookLeaseScopeSchema,
  reason: z.string().min(1).max(500),
})

export const getOperationRequestSchema = z.object({
  command: z.literal("get_operation"),
  operationId: z.string().min(1),
})

export const reconcileLeaseEventSchema = z.object({
  command: z.literal("reconcile_live_webhook_lease"),
  operationId: z.string().min(1),
  leaseId: z.string().min(1),
})

export const reconcileRouteableDeploymentEventSchema = z.object({
  command: z.literal("reconcile_routeable_deployment"),
  operationId: z.string().min(1),
  routeableDeploymentId: z.string().min(1),
})

export const sweepDriftEventSchema = z.object({
  command: z.literal("sweep_drift"),
  requestId: z.string().min(1),
})

export const trafficControllerApiCommandSchema = z.discriminatedUnion("command", [
  ensureRouteableDeploymentRequestSchema,
  ensureLiveWebhookLeaseRequestSchema,
  getOperationRequestSchema,
])

export const trafficControllerReconcileCommandSchema = z.discriminatedUnion("command", [
  reconcileRouteableDeploymentEventSchema,
  reconcileLeaseEventSchema,
  sweepDriftEventSchema,
])

export const operationReceiptSchema = z.object({
  status: z.literal("accepted"),
  operationId: z.string().min(1),
  resourceId: z.string().min(1).optional(),
})

export const operationStateSchema = z.object({
  status: z.literal("operation"),
  operation: z.object({
    operationId: z.string().min(1),
    operationType: z.string().min(1),
    status: trafficControlOperationStatusSchema,
    resultCode: z.string().min(1).optional(),
    resultMessage: z.string().min(1).optional(),
    leaseId: z.string().min(1).optional(),
    routeableDeploymentId: z.string().min(1).optional(),
    output: z.record(z.string(), z.unknown()).optional(),
  }),
})

export const rejectedCommandSchema = z.object({
  status: z.literal("rejected"),
  code: z.string().min(1),
  message: z.string().min(1),
})

export const trafficControllerApiResponseSchema = z.union([
  operationReceiptSchema,
  operationStateSchema,
  rejectedCommandSchema,
])

export type EnsureRouteableDeploymentRequest = z.infer<
  typeof ensureRouteableDeploymentRequestSchema
>
export type EnsureLiveWebhookLeaseRequest = z.infer<typeof ensureLiveWebhookLeaseRequestSchema>
export type GetOperationRequest = z.infer<typeof getOperationRequestSchema>
export type TrafficControllerApiCommand = z.infer<typeof trafficControllerApiCommandSchema>
export type TrafficControllerReconcileCommand = z.infer<
  typeof trafficControllerReconcileCommandSchema
>
export type TrafficControllerApiResponse = z.infer<typeof trafficControllerApiResponseSchema>

export function isFinalOperationStatus(
  status: z.infer<typeof trafficControlOperationStatusSchema>,
): boolean {
  return status === "succeeded" || status === "failed" || status === "rejected"
}
