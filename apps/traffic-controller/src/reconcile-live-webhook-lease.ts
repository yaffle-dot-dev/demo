import {
  markOperationFailed,
  markOperationRunning,
  markOperationSucceeded,
} from "./db/queries/operations.ts"
import {
  findLiveWebhookLeaseWithDeploymentById,
  listActiveLiveWebhookLeasesWithDeployments,
  updateLiveWebhookLease,
} from "./db/queries/live-webhook-leases.ts"
import { createTrafficControlAuditEvent } from "./db/queries/audit-events.ts"
import { updateRouteableDeploymentHookdeckMetadata } from "./db/queries/routeable-deployments.ts"
import {
  createHookdeckRoutingClient,
  getHookdeckRoutingConfig,
  type HookdeckRoutingClient,
  type HookdeckRoutingConfig,
} from "./hookdeck-client.ts"
import {
  buildHookdeckDestinationName,
  buildHookdeckPreviewConnectionName,
  buildHookdeckPreviewConnectionRules,
  buildHookdeckProductionConnections,
} from "./hookdeck-routing.ts"

interface ReconcileLiveWebhookLeaseInput {
  operationId: string
  leaseId: string
}

interface ReconcileLiveWebhookLeaseDeps {
  markOperationRunning: typeof markOperationRunning
  markOperationSucceeded: typeof markOperationSucceeded
  markOperationFailed: typeof markOperationFailed
  findLease: typeof findLiveWebhookLeaseWithDeploymentById
  listActiveLeases: typeof listActiveLiveWebhookLeasesWithDeployments
  updateLease: typeof updateLiveWebhookLease
  updateRouteableDeploymentHookdeckMetadata: typeof updateRouteableDeploymentHookdeckMetadata
  getHookdeckRoutingConfig: typeof getHookdeckRoutingConfig
  createHookdeckRoutingClient: typeof createHookdeckRoutingClient
  createAuditEvent: typeof createTrafficControlAuditEvent
}

const defaultDeps: ReconcileLiveWebhookLeaseDeps = {
  markOperationRunning,
  markOperationSucceeded,
  markOperationFailed,
  findLease: findLiveWebhookLeaseWithDeploymentById,
  listActiveLeases: listActiveLiveWebhookLeasesWithDeployments,
  updateLease: updateLiveWebhookLease,
  updateRouteableDeploymentHookdeckMetadata,
  getHookdeckRoutingConfig,
  createHookdeckRoutingClient,
  createAuditEvent: createTrafficControlAuditEvent,
}

async function ensureRouteableDeploymentDestination(params: {
  lease: NonNullable<Awaited<ReturnType<typeof findLiveWebhookLeaseWithDeploymentById>>>
  hookdeck: HookdeckRoutingClient
  updateRouteableDeploymentHookdeckMetadata: typeof updateRouteableDeploymentHookdeckMetadata
}): Promise<{ destinationId: string; destinationName: string }> {
  const destinationName =
    params.lease.routeableDeployment.hookdeckDestinationName ??
    buildHookdeckDestinationName(params.lease.routeableDeployment.externalDeploymentId)
  const destination = await params.hookdeck.upsertDestination({
    name: destinationName,
    description: `Routeable deployment for Yaffle PR ${params.lease.routeableDeployment.prNumber}`,
    url: params.lease.routeableDeployment.receiverUrl,
    pathForwardingDisabled: true,
  })

  await params.updateRouteableDeploymentHookdeckMetadata(params.lease.routeableDeployment.id, {
    hookdeckDestinationId: destination.id,
    hookdeckDestinationName: destination.name ?? destinationName,
    lastReconciledAt: new Date(),
    lastSyncError: null,
  })

  return {
    destinationId: destination.id,
    destinationName: destination.name ?? destinationName,
  }
}

async function reconcileProductionConnections(params: {
  hookdeck: HookdeckRoutingClient
  config: HookdeckRoutingConfig
  activeLeases: Awaited<ReturnType<typeof listActiveLiveWebhookLeasesWithDeployments>>
}): Promise<void> {
  const desiredConnections = buildHookdeckProductionConnections({
    baseConnectionName: params.config.productionConnectionName,
    sourceId: params.config.githubSourceId,
    destinationId: params.config.productionDestinationId,
    activeLeases: params.activeLeases,
  })

  for (const connection of desiredConnections) {
    await params.hookdeck.upsertConnection({
      name: connection.name,
      description: connection.description,
      sourceId: connection.sourceId,
      destinationId: connection.destinationId,
      rules: connection.rules,
    })
  }
}

export async function reconcileLiveWebhookLease(
  input: ReconcileLiveWebhookLeaseInput,
  deps: ReconcileLiveWebhookLeaseDeps = defaultDeps,
): Promise<void> {
  await deps.markOperationRunning(input.operationId)

  try {
    const lease = await deps.findLease(input.leaseId)
    if (!lease) {
      throw new Error(`live webhook lease ${input.leaseId} not found`)
    }

    const config = await deps.getHookdeckRoutingConfig()
    const hookdeck = await deps.createHookdeckRoutingClient()

    if (lease.status === "revoking") {
      if (lease.hookdeckConnectionId) {
        await hookdeck.deleteConnection(lease.hookdeckConnectionId)
      }

      const activeLeases = (await deps.listActiveLeases()).filter(
        (candidate) => candidate.id !== lease.id,
      )
      await reconcileProductionConnections({
        hookdeck,
        config,
        activeLeases,
      })

      await deps.updateLease(lease.id, {
        status: "revoked",
        revokedAt: new Date(),
        lastReconciledAt: new Date(),
        lastSyncError: null,
        hookdeckConnectionId: null,
        hookdeckConnectionName: null,
      })

      await deps.markOperationSucceeded(input.operationId, {
        liveWebhookLeaseId: lease.id,
        routeableDeploymentId: lease.routeableDeployment.id,
        output: {
          leaseId: lease.id,
          status: "revoked",
          hookdeckConnectionId: lease.hookdeckConnectionId,
        },
      })
      await deps.createAuditEvent({
        operationId: input.operationId,
        routeableDeploymentId: lease.routeableDeployment.id,
        liveWebhookLeaseId: lease.id,
        actorGithubUserId: lease.actorGithubUserId,
        actorGithubLoginSnapshot: lease.actorGithubLoginSnapshot,
        eventType: "live_webhook_lease.revoked",
        details: {
          hookdeckConnectionId: lease.hookdeckConnectionId,
        },
      })
      return
    }

    const { destinationId, destinationName } = await ensureRouteableDeploymentDestination({
      lease,
      hookdeck,
      updateRouteableDeploymentHookdeckMetadata: deps.updateRouteableDeploymentHookdeckMetadata,
    })

    const previewConnection = await hookdeck.upsertConnection({
      name: buildHookdeckPreviewConnectionName(lease.id),
      description: `Live lease for Yaffle PR ${lease.prNumber}`,
      sourceId: config.githubSourceId,
      destinationId,
      rules: buildHookdeckPreviewConnectionRules(lease),
    })

    const activeLeases = await deps.listActiveLeases()
    const desiredActiveLeases = [
      ...activeLeases.filter((candidate) => candidate.id !== lease.id),
      {
        ...lease,
        status: "active" as const,
        hookdeckDestinationId: destinationId,
        hookdeckDestinationName: destinationName,
        hookdeckConnectionId: previewConnection.id,
        hookdeckConnectionName:
          previewConnection.name ?? buildHookdeckPreviewConnectionName(lease.id),
        routeableDeployment: {
          ...lease.routeableDeployment,
          hookdeckDestinationId: destinationId,
          hookdeckDestinationName: destinationName,
        },
      },
    ]

    await reconcileProductionConnections({
      hookdeck,
      config,
      activeLeases: desiredActiveLeases,
    })

    await deps.updateLease(lease.id, {
      status: "active",
      activatedAt: lease.activatedAt ?? new Date(),
      hookdeckDestinationId: destinationId,
      hookdeckDestinationName: destinationName,
      hookdeckConnectionId: previewConnection.id,
      hookdeckConnectionName:
        previewConnection.name ?? buildHookdeckPreviewConnectionName(lease.id),
      lastReconciledAt: new Date(),
      lastSyncError: null,
    })

    await deps.markOperationSucceeded(input.operationId, {
      liveWebhookLeaseId: lease.id,
      routeableDeploymentId: lease.routeableDeployment.id,
      output: {
        leaseId: lease.id,
        status: "active",
        hookdeckDestinationId: destinationId,
        hookdeckDestinationName: destinationName,
        hookdeckConnectionId: previewConnection.id,
        hookdeckConnectionName:
          previewConnection.name ?? buildHookdeckPreviewConnectionName(lease.id),
      },
    })
    await deps.createAuditEvent({
      operationId: input.operationId,
      routeableDeploymentId: lease.routeableDeployment.id,
      liveWebhookLeaseId: lease.id,
      actorGithubUserId: lease.actorGithubUserId,
      actorGithubLoginSnapshot: lease.actorGithubLoginSnapshot,
      eventType: "live_webhook_lease.activated",
      details: {
        hookdeckDestinationId: destinationId,
        hookdeckDestinationName: destinationName,
        hookdeckConnectionId: previewConnection.id,
        hookdeckConnectionName:
          previewConnection.name ?? buildHookdeckPreviewConnectionName(lease.id),
      },
    })
  } catch (error) {
    await deps.markOperationFailed(input.operationId, {
      resultCode: "RECONCILE_LIVE_WEBHOOK_LEASE_FAILED",
      resultMessage: error instanceof Error ? error.message : String(error),
    })
    await deps.createAuditEvent({
      operationId: input.operationId,
      liveWebhookLeaseId: input.leaseId,
      eventType: "live_webhook_lease.reconcile_failed",
      details: {
        error: error instanceof Error ? error.message : String(error),
      },
    })
    throw error
  }
}
