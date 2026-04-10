import { Hono } from "hono"
import { z } from "zod"

import { requireAuth, AuthError, type AuthContext } from "../lib/auth.ts"
import { findOrgBySlug, findOrgMembership, updateOrg, type Organization } from "../db/queries/organizations.ts"
import { requireStripe } from "../lib/stripe.ts"
import { getEnv } from "../lib/env.ts"
import { logger } from "../lib/telemetry.ts"

export const billingRoute = new Hono()

/**
 * Resolve org from slug, verify user is an admin member.
 */
async function resolveOrgAdmin(
  headers: Headers,
  slug: string,
): Promise<{ auth: AuthContext; org: Organization } | { error: true; status: number; code: string; message: string }> {
  let auth: AuthContext
  try {
    auth = await requireAuth(headers)
  } catch (err) {
    if (err instanceof AuthError) {
      return { error: true, status: err.code === "AUTH_REQUIRED" ? 401 : 403, code: err.code, message: err.message }
    }
    throw err
  }

  const org = await findOrgBySlug(slug)
  if (!org) {
    return { error: true, status: 404, code: "NOT_FOUND", message: "Organization not found" }
  }

  const membership = await findOrgMembership(org.id, auth.userId)
  if (!membership || membership.role !== "admin") {
    return { error: true, status: 403, code: "FORBIDDEN", message: "Admin access required" }
  }

  return { auth, org }
}

const checkoutSchema = z.object({
  priceId: z.string().min(1),
})

/**
 * POST /api/orgs/:slug/billing/checkout
 *
 * Create a Stripe Checkout session for subscribing to a plan.
 * Returns the Checkout URL for the frontend to redirect to.
 */
billingRoute.post("/:slug/billing/checkout", async (c) => {
  const result = await resolveOrgAdmin(c.req.raw.headers, c.req.param("slug"))
  if ("error" in result) {
    return c.json({ error: { code: result.code, message: result.message } }, result.status as any)
  }

  let { org } = result

  let body: z.infer<typeof checkoutSchema>
  try {
    body = checkoutSchema.parse(await c.req.json())
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: err.errors[0].message } }, 400)
    }
    return c.json({ error: { code: "INVALID_JSON", message: "Invalid request body" } }, 400)
  }

  // Auto-create Stripe customer only after the request is known-valid.
  if (!org.stripeCustomerId) {
    const stripe = requireStripe()
    const customer = await stripe.customers.create({
      name: org.name,
      metadata: { orgId: org.id, orgSlug: org.slug },
    })
    org = (await updateOrg(org.id, { stripeCustomerId: customer.id }))!
    logger.info(`created Stripe customer for org ${org.slug}`, {
      "yaffle.org": org.slug,
      "stripe.customer_id": customer.id,
    })
  }

  const stripe = requireStripe()
  const env = getEnv()
  const appUrl = env.betterAuthUrl // base URL of the app

  const session = await stripe.checkout.sessions.create({
    customer: org.stripeCustomerId ?? undefined,
    mode: "subscription",
    line_items: [{ price: body.priceId, quantity: 1 }],
    success_url: `${appUrl}/${org.slug}/settings/billing?checkout=success`,
    cancel_url: `${appUrl}/${org.slug}/settings/billing?checkout=canceled`,
    metadata: {
      orgId: org.id,
      orgSlug: org.slug,
    },
  })

  return c.json({ data: { url: session.url } })
})

/**
 * POST /api/orgs/:slug/billing/portal
 *
 * Create a Stripe Customer Portal session.
 * Returns the portal URL for the frontend to redirect to.
 */
billingRoute.post("/:slug/billing/portal", async (c) => {
  const result = await resolveOrgAdmin(c.req.raw.headers, c.req.param("slug"))
  if ("error" in result) {
    return c.json({ error: { code: result.code, message: result.message } }, result.status as any)
  }

  const { org } = result

  if (!org.stripeCustomerId) {
    return c.json({ error: { code: "NO_BILLING_ACCOUNT", message: "No subscription found. Subscribe to a plan first." } }, 400)
  }

  const stripe = requireStripe()
  const env = getEnv()
  const appUrl = env.betterAuthUrl

  const session = await stripe.billingPortal.sessions.create({
    customer: org.stripeCustomerId,
    return_url: `${appUrl}/${org.slug}/settings/billing`,
  })

  return c.json({ data: { url: session.url } })
})
