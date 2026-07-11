import { and, eq, ne, gte, countDistinct, count } from "drizzle-orm"

import { db } from "./db.ts"
import { runGroups, workspaceDeployments } from "../db/schema.ts"
import type { Organization } from "../db/queries/organizations.ts"
import { findPlanLimitedDeployments, updateDeploymentStatus } from "../db/queries/workspace-deployments.ts"
import { createIacJob } from "../db/queries/iac-jobs.ts"
import { logger } from "./telemetry.ts"

// =============================================================================
// Free tier limits (injected from Terraform outputs at deploy time)
// =============================================================================
// Validated eagerly at import time — server won't start if these are missing.

function requireEnvInt(name: string): number {
  const val = process.env[name]
  if (val === undefined || val === "") {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  const parsed = Number(val)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer for ${name}: ${val}`)
  }
  return parsed
}

const FREE_LIMITS = {
  concurrentPreviewBranches: requireEnvInt("YAFFLE_FREE_LIMIT_CONCURRENT_PREVIEWS"),
  previewCreationsPerMonth: requireEnvInt("YAFFLE_FREE_LIMIT_MONTHLY_PREVIEWS"),
  namedEnvironments: requireEnvInt("YAFFLE_FREE_LIMIT_NAMED_ENVIRONMENTS"),
}

export type EntitlementResult =
  | { allowed: true }
  | { allowed: false; code: string; message: string }

/**
 * Check whether an org is allowed to use an environment kind.
 * Returns { allowed: true } or { allowed: false, code, message }.
 */
export async function checkOrgEntitlements(
  org: Organization,
  environmentKind: "named" | "transient",
  environmentName?: string,
): Promise<EntitlementResult> {
  // Subscription status checks (all tiers)
  if (org.subscriptionStatus === "canceled" || org.subscriptionStatus === "unpaid") {
    return {
      allowed: false,
      code: "SUBSCRIPTION_INACTIVE",
      message: `Your Yaffle subscription is ${org.subscriptionStatus}. Please update your billing at /${org.slug}/settings/billing to continue using Yaffle.`,
    }
  }

  // Paid tiers have no limits
  if (org.planTier !== "free") {
    return { allowed: true }
  }

  // Free tier: check limits based on environment kind
  if (environmentKind === "transient") {
    return checkFreePreviewLimits(org)
  }

  if (environmentKind === "named") {
    return checkFreeEnvironmentLimits(org, environmentName)
  }

  return { allowed: true }
}

/**
 * Check free tier preview limits:
 * - Max 5 concurrent preview branches
 * - Max 25 preview creations per month
 */
async function checkFreePreviewLimits(org: Organization): Promise<EntitlementResult> {
  // Count concurrent active preview branches (distinct environment names for transient envs)
  const concurrentResult = await db
    .select({ count: countDistinct(runGroups.environmentName) })
    .from(runGroups)
    .where(
      and(
        eq(runGroups.orgId, org.id),
        eq(runGroups.environmentKind, "transient"),
        ne(runGroups.status, "success"),
        ne(runGroups.status, "failed"),
      ),
    )

  const concurrentBranches = concurrentResult[0]?.count ?? 0
  if (concurrentBranches >= FREE_LIMITS.concurrentPreviewBranches) {
    return {
      allowed: false,
      code: "FREE_TIER_CONCURRENT_LIMIT",
      message: `Free tier limit: ${FREE_LIMITS.concurrentPreviewBranches} concurrent preview branches. You have ${concurrentBranches} active. Upgrade to Pro at /${org.slug}/settings/billing for unlimited previews.`,
    }
  }

  // Count preview creations this calendar month
  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)

  const monthlyResult = await db
    .select({ count: count() })
    .from(runGroups)
    .where(
      and(
        eq(runGroups.orgId, org.id),
        eq(runGroups.environmentKind, "transient"),
        gte(runGroups.createdAt, startOfMonth),
      ),
    )

  const monthlyCreations = monthlyResult[0]?.count ?? 0
  if (monthlyCreations >= FREE_LIMITS.previewCreationsPerMonth) {
    return {
      allowed: false,
      code: "FREE_TIER_MONTHLY_LIMIT",
      message: `Free tier limit: ${FREE_LIMITS.previewCreationsPerMonth} preview creations per month. You've used ${monthlyCreations} this month. Upgrade to Pro at /${org.slug}/settings/billing for unlimited previews.`,
    }
  }

  return { allowed: true }
}

/**
 * Check free tier named environment limits:
 * - Max 1 named environment
 * - Pushes to an existing environment are always allowed
 */
async function checkFreeEnvironmentLimits(org: Organization, environmentName?: string): Promise<EntitlementResult> {
  // Count distinct named environments this org has deployments for
  const result = await db
    .select({ count: countDistinct(workspaceDeployments.environmentName) })
    .from(workspaceDeployments)
    .where(
      and(
        eq(workspaceDeployments.orgId, org.id),
        eq(workspaceDeployments.environmentKind, "named"),
      ),
    )

  const namedEnvCount = result[0]?.count ?? 0

  // If we're pushing to an environment that already exists, always allow it
  if (environmentName && namedEnvCount > 0) {
    const existing = await db
      .select({ count: countDistinct(workspaceDeployments.environmentName) })
      .from(workspaceDeployments)
      .where(
        and(
          eq(workspaceDeployments.orgId, org.id),
          eq(workspaceDeployments.environmentKind, "named"),
          eq(workspaceDeployments.environmentName, environmentName),
        ),
      )
    if ((existing[0]?.count ?? 0) > 0) {
      return { allowed: true }
    }
  }

  if (namedEnvCount >= FREE_LIMITS.namedEnvironments) {
    return {
      allowed: false,
      code: "FREE_TIER_ENVIRONMENT_LIMIT",
      message: `Free tier limit: ${FREE_LIMITS.namedEnvironments} named environment. You have ${namedEnvCount}. Upgrade to Pro at /${org.slug}/settings/billing for unlimited environments.`,
    }
  }

  return { allowed: true }
}

// =============================================================================
// Re-queue plan_limited deployments
// =============================================================================

/**
 * Re-queue plan_limited deployments for an org, respecting current entitlements.
 * Called when an org's subscription changes (upgrade, plan change, etc.).
 *
 * Processes oldest deployments first. For each, re-checks entitlements under
 * the org's current plan. Stops when entitlements say no more capacity.
 *
 * Returns the number of deployments re-queued.
 */
export async function requeuePlanLimitedDeployments(org: Organization): Promise<number> {
  const deployments = await findPlanLimitedDeployments(org.id)
  if (deployments.length === 0) return 0

  let requeued = 0

  for (const deployment of deployments) {
    // Re-check entitlements with current plan state
    const check = await checkOrgEntitlements(org, deployment.environmentKind)

    if (!check.allowed) {
      // Hit the new limit — stop re-queuing
      logger.info(`re-queue stopped at limit: ${check.code}`, {
        "yaffle.org": org.slug,
        "yaffle.requeued": requeued,
        "yaffle.remaining_limited": deployments.length - requeued,
      })
      break
    }

    // Re-queue: set status to pending and create a plan job
    await updateDeploymentStatus(deployment.id, "pending")
    await createIacJob({
      deploymentId: deployment.id,
      jobType: "plan",
    })
    requeued++
  }

  if (requeued > 0) {
    logger.info(`re-queued ${requeued} plan-limited deployments for org ${org.slug}`, {
      "yaffle.org": org.slug,
      "yaffle.requeued": requeued,
    })
  }

  return requeued
}
