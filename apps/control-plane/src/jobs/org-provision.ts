/**
 * Org Provisioning Job Handler
 *
 * Creates AWS resources (KMS key, IAM role) for a new organization.
 * Uses exponential backoff with max 5 attempts.
 */

import { findOrgById, updateOrg } from "../db/queries/organizations.ts"
import { provisionOrgResources } from "../lib/org-provisioning.ts"
import {
  logger,
  getProvisioningAttemptsCounter,
  getProvisioningDurationHistogram,
  getProvisioningFailuresCounter,
  getProvisioningPermanentFailuresCounter,
} from "../lib/telemetry.ts"

const MAX_ATTEMPTS = 5

export interface OrgProvisionPayload {
  orgId: string
  orgSlug: string
}

/**
 * Handle an org provisioning job.
 *
 * Workflow:
 * 1. Check if already provisioned (idempotent)
 * 2. Check if max attempts exceeded
 * 3. Mark as provisioning, increment attempts
 * 4. Create AWS resources (KMS key, IAM role)
 * 5. Update org with resource ARNs and mark as active
 *
 * On failure:
 * - If under max attempts: mark as pending, re-queue with backoff
 * - If at max attempts: mark as failed, create incident
 */
export async function handleOrgProvisionJob(payload: OrgProvisionPayload): Promise<void> {
  const { orgId, orgSlug } = payload
  const startTime = Date.now()

  // Common attributes for all log entries - makes filtering in Axiom easy
  const logContext = {
    orgId,
    orgSlug,
    component: "org_provisioning",
  }

  logger.info("org.provisioning.started", logContext)

  const org = await findOrgById(orgId)
  if (!org) {
    logger.error("org.provisioning.org_not_found", logContext)
    getProvisioningFailuresCounter().add(1, {
      org_id: orgId,
      org_slug: orgSlug,
      error_type: "org_not_found",
    })
    throw new Error(`Organization ${orgId} not found`)
  }

  // Already done?
  if (org.provisioningStatus === "active") {
    logger.info("org.provisioning.already_complete", logContext)
    return
  }

  const attempt = org.provisioningAttempts + 1

  // Too many failures?
  if (org.provisioningAttempts >= MAX_ATTEMPTS) {
    logger.error("org.provisioning.max_attempts_exceeded", {
      ...logContext,
      attempt,
      maxAttempts: MAX_ATTEMPTS,
    })

    await updateOrg(orgId, {
      provisioningStatus: "failed",
      provisioningError: "Max attempts exceeded. Support has been notified.",
    })

    // Record permanent failure metric
    getProvisioningPermanentFailuresCounter().add(1, {
      org_id: orgId,
      org_slug: orgSlug,
    })

    // INCIDENT log - this should trigger alerts in Axiom
    logger.error("org.provisioning.incident", {
      ...logContext,
      attempt,
      maxAttempts: MAX_ATTEMPTS,
      incidentType: "permanent_failure",
      message: "Org provisioning failed permanently after max attempts",
    })
    return
  }

  // Mark as provisioning and increment attempts
  await updateOrg(orgId, {
    provisioningStatus: "provisioning",
    provisioningAttempts: attempt,
    provisioningError: null,
  })

  logger.info("org.provisioning.attempt_started", {
    ...logContext,
    attempt,
    maxAttempts: MAX_ATTEMPTS,
  })

  try {
    const result = await provisionOrgResources(orgId, orgSlug)
    const durationMs = Date.now() - startTime

    await updateOrg(orgId, {
      kmsKeyArn: result.kmsKeyArn,
      kmsKeyAlias: result.kmsKeyAlias,
      iamRoleArn: result.iamRoleArn,
      provisioningStatus: "active",
      provisioningError: null,
    })

    // Record success metrics
    getProvisioningAttemptsCounter().add(1, {
      org_id: orgId,
      org_slug: orgSlug,
      status: "success",
      attempt: String(attempt),
    })
    getProvisioningDurationHistogram().record(durationMs, {
      org_id: orgId,
      org_slug: orgSlug,
      status: "success",
    })

    logger.info("org.provisioning.success", {
      ...logContext,
      attempt,
      durationMs,
      kmsKeyArn: result.kmsKeyArn,
      iamRoleArn: result.iamRoleArn,
    })
  } catch (err) {
    const durationMs = Date.now() - startTime

    // Extract full error details from AWS SDK errors
    const errorMessage = err instanceof Error ? err.message : String(err)
    const errorName = err instanceof Error ? err.name : "Unknown"
    const errorStack = err instanceof Error ? err.stack : undefined
    // AWS SDK errors have additional properties
    const awsError = err as { $metadata?: Record<string, unknown>; Code?: string; $fault?: string }
    const awsErrorCode = awsError.Code ?? errorName

    // Record failure metrics
    getProvisioningAttemptsCounter().add(1, {
      org_id: orgId,
      org_slug: orgSlug,
      status: "failure",
      attempt: String(attempt),
    })
    getProvisioningFailuresCounter().add(1, {
      org_id: orgId,
      org_slug: orgSlug,
      error_type: awsErrorCode,
    })
    getProvisioningDurationHistogram().record(durationMs, {
      org_id: orgId,
      org_slug: orgSlug,
      status: "failure",
    })

    logger.error("org.provisioning.attempt_failed", {
      ...logContext,
      attempt,
      maxAttempts: MAX_ATTEMPTS,
      durationMs,
      error: errorMessage,
      errorType: awsErrorCode,
      errorStack,
      awsMetadata: awsError.$metadata ? JSON.stringify(awsError.$metadata) : undefined,
      awsFault: awsError.$fault,
    })

    if (attempt >= MAX_ATTEMPTS) {
      await updateOrg(orgId, {
        provisioningStatus: "failed",
        provisioningError: errorMessage,
      })

      // Record permanent failure
      getProvisioningPermanentFailuresCounter().add(1, {
        org_id: orgId,
        org_slug: orgSlug,
        error_type: awsErrorCode,
      })

      // INCIDENT log - this should trigger alerts in Axiom
      logger.error("org.provisioning.incident", {
        ...logContext,
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        incidentType: "permanent_failure",
        error: errorMessage,
        errorType: awsErrorCode,
        message: "Org provisioning failed permanently after max attempts",
      })
    } else {
      // Mark as pending for retry
      await updateOrg(orgId, {
        provisioningStatus: "pending",
        provisioningError: errorMessage,
      })

      logger.warn("org.provisioning.will_retry", {
        ...logContext,
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        nextAttempt: attempt + 1,
        error: errorMessage,
        errorType: awsErrorCode,
      })

      // Re-throw to trigger job retry with exponential backoff
      throw err
    }
  }
}

/**
 * Calculate backoff delay for retry.
 * Uses exponential backoff: 5s, 10s, 20s, 40s, 80s
 */
export function calculateBackoffMs(attempt: number): number {
  const baseMs = 5000 // 5 seconds
  const maxMs = 300000 // 5 minutes
  const delayMs = Math.min(baseMs * Math.pow(2, attempt - 1), maxMs)
  return delayMs
}
