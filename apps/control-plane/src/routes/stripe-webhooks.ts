import { Hono } from "hono"

import { requireStripe } from "../lib/stripe.ts"
import { updateOrg, findOrgById } from "../db/queries/organizations.ts"
import { requeuePlanLimitedDeployments } from "../lib/entitlements.ts"
import { db } from "../lib/db.ts"
import { organizations } from "../db/schema.ts"
import { eq } from "drizzle-orm"
import { logger } from "../lib/telemetry.ts"

export const stripeWebhooksRoute = new Hono()

/**
 * Look up the org by Stripe customer ID.
 */
async function findOrgByStripeCustomerId(customerId: string) {
  const rows = await db
    .select({ id: organizations.id, slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.stripeCustomerId, customerId))
    .limit(1)
  return rows[0] ?? null
}

/**
 * Resolve plan tier from a Stripe price's metadata.
 * Falls back to "pro" if metadata is missing (defensive).
 */
function resolvePlanTier(priceMetadata: Record<string, string> | null | undefined): string {
  return priceMetadata?.plan_tier ?? "pro"
}

/**
 * POST /api/webhooks/stripe
 *
 * Handles Stripe webhook events for subscription lifecycle.
 * Verifies signature, then updates org billing state.
 */
stripeWebhooksRoute.post("/", async (c) => {
  const stripe = requireStripe()
  const webhookSecret = process.env.STRIPE_WEBHOOK_SIGNING_SECRET
  if (!webhookSecret) {
    logger.error("STRIPE_WEBHOOK_SIGNING_SECRET not configured")
    return c.json({ error: "webhook secret not configured" }, 500)
  }

  // Verify webhook signature
  const body = await c.req.text()
  const signature = c.req.header("stripe-signature")
  if (!signature) {
    return c.json({ error: "missing stripe-signature header" }, 400)
  }

  let event
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret)
  } catch (err) {
    logger.warn("stripe webhook signature verification failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return c.json({ error: "invalid signature" }, 400)
  }

  logger.info(`stripe webhook: ${event.type}`, {
    "stripe.event_type": event.type,
    "stripe.event_id": event.id,
  })

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object
      if (session.mode !== "subscription" || !session.customer || !session.subscription) break

      const customerId =
        typeof session.customer === "string" ? session.customer : session.customer.id
      const org = await findOrgByStripeCustomerId(customerId)
      if (!org) {
        logger.warn(`stripe webhook: no org for customer ${customerId}`)
        break
      }

      // Fetch the subscription to get the price and its metadata
      const subscription = await stripe.subscriptions.retrieve(session.subscription as string, {
        expand: ["items.data.price"],
      })
      const price = subscription.items.data[0]?.price
      const planTier = resolvePlanTier(price?.metadata as Record<string, string>)

      await updateOrg(org.id, {
        subscriptionStatus: "active",
        planTier,
      })

      logger.info(`org ${org.slug} subscribed to ${planTier}`, {
        "yaffle.org": org.slug,
        "stripe.subscription_id": subscription.id,
        "yaffle.plan_tier": planTier,
      })

      // Re-queue any plan_limited deployments under the new plan
      const updatedOrg = await findOrgById(org.id)
      if (updatedOrg) {
        await requeuePlanLimitedDeployments(updatedOrg)
      }
      break
    }

    case "invoice.paid": {
      const invoice = event.data.object
      if (!invoice.customer) break

      const customerId =
        typeof invoice.customer === "string" ? invoice.customer : invoice.customer.id
      const org = await findOrgByStripeCustomerId(customerId)
      if (!org) break

      // Keep subscription active on successful payment
      await updateOrg(org.id, { subscriptionStatus: "active" })
      break
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object
      if (!invoice.customer) break

      const customerId =
        typeof invoice.customer === "string" ? invoice.customer : invoice.customer.id
      const org = await findOrgByStripeCustomerId(customerId)
      if (!org) break

      await updateOrg(org.id, { subscriptionStatus: "past_due" })
      logger.warn(`org ${org.slug} payment failed`, { "yaffle.org": org.slug })
      break
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object
      if (!subscription.customer) break

      const customerId =
        typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id
      const org = await findOrgByStripeCustomerId(customerId)
      if (!org) break

      const price = subscription.items.data[0]?.price
      const planTier = resolvePlanTier(price?.metadata as Record<string, string>)
      const status = subscription.status // active, past_due, canceled, unpaid, etc.

      await updateOrg(org.id, {
        subscriptionStatus: status,
        planTier,
      })

      logger.info(`org ${org.slug} subscription updated: status=${status} tier=${planTier}`, {
        "yaffle.org": org.slug,
        "stripe.subscription_status": status,
        "yaffle.plan_tier": planTier,
      })

      // Re-queue any plan_limited deployments if plan changed
      const updatedOrg = await findOrgById(org.id)
      if (updatedOrg) {
        await requeuePlanLimitedDeployments(updatedOrg)
      }
      break
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object
      if (!subscription.customer) break

      const customerId =
        typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id
      const org = await findOrgByStripeCustomerId(customerId)
      if (!org) break

      await updateOrg(org.id, {
        subscriptionStatus: "canceled",
        planTier: "free",
      })

      logger.info(`org ${org.slug} subscription canceled`, { "yaffle.org": org.slug })
      break
    }

    default:
      logger.info(`stripe webhook: unhandled event type ${event.type}`)
  }

  return c.json({ received: true })
})
