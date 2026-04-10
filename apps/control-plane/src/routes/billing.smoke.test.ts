import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Hono } from "hono"

// Import test utils FIRST so dev auth is enabled before route modules load.
import { cleanupTestData, createTestContext, type TestContext } from "../test-utils/auth.ts"

import { db } from "../lib/db.ts"
import { organizations } from "../db/schema.ts"

process.env.YAFFLE_FREE_LIMIT_CONCURRENT_PREVIEWS = process.env.YAFFLE_FREE_LIMIT_CONCURRENT_PREVIEWS ?? "5"
process.env.YAFFLE_FREE_LIMIT_MONTHLY_PREVIEWS = process.env.YAFFLE_FREE_LIMIT_MONTHLY_PREVIEWS ?? "25"
process.env.YAFFLE_FREE_LIMIT_NAMED_ENVIRONMENTS = process.env.YAFFLE_FREE_LIMIT_NAMED_ENVIRONMENTS ?? "1"
process.env.STRIPE_WEBHOOK_SIGNING_SECRET = "whsec_smoke_test"

const mockCustomersCreate = mock(async (_input: unknown) => ({
  id: "cus_smoke_123",
}))
const mockCheckoutSessionsCreate = mock(async (_input: unknown) => ({
  url: "https://checkout.stripe.test/session/cs_smoke_123",
}))
const mockPortalSessionsCreate = mock(async (_input: unknown) => ({
  url: "https://billing.stripe.test/session/bps_smoke_123",
}))
const mockConstructEvent = mock((body: string, signature: string, secret: string) => {
  if (signature !== "valid-signature") {
    throw new Error("invalid signature")
  }

  if (secret !== "whsec_smoke_test") {
    throw new Error("invalid webhook secret")
  }

  return JSON.parse(body)
})
const mockSubscriptionsRetrieve = mock(async (subscriptionId: string, _input: unknown) => ({
  id: subscriptionId,
  items: {
    data: [
      {
        price: {
          metadata: {
            plan_tier: "pro",
          },
        },
      },
    ],
  },
}))
const mockRequeuePlanLimitedDeployments = mock(async (_org: unknown) => 0)

mock.module("../lib/stripe.ts", () => ({
  requireStripe: () => ({
    customers: {
      create: mockCustomersCreate,
    },
    checkout: {
      sessions: {
        create: mockCheckoutSessionsCreate,
      },
    },
    billingPortal: {
      sessions: {
        create: mockPortalSessionsCreate,
      },
    },
    webhooks: {
      constructEvent: mockConstructEvent,
    },
    subscriptions: {
      retrieve: mockSubscriptionsRetrieve,
    },
  }),
}))

mock.module("../lib/entitlements.ts", () => ({
  requeuePlanLimitedDeployments: mockRequeuePlanLimitedDeployments,
}))

const { billingRoute } = await import("./billing.ts")
const { stripeWebhooksRoute } = await import("./stripe-webhooks.ts")

const app = new Hono()
app.route("/api/orgs", billingRoute)
app.route("/api/webhooks/stripe", stripeWebhooksRoute)

let adminCtx: TestContext
let viewerCtx: TestContext
let orgSlug: string

function headersFrom(ctx: TestContext): Headers {
  return new Headers(ctx.headers)
}

async function reqAs(ctx: TestContext, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = headersFrom(ctx)
  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  }

  return app.request(path, {
    ...init,
    headers,
  })
}

async function getOrgRecord() {
  const rows = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, adminCtx.org.id))
    .limit(1)

  return rows[0] ?? null
}

beforeEach(async () => {
  orgSlug = `billing-smoke-${crypto.randomUUID().slice(0, 8)}`
  adminCtx = await createTestContext({ orgSlug, role: "admin" })
  viewerCtx = await createTestContext({ orgSlug, role: "viewer" })

  mockCustomersCreate.mockReset()
  mockCustomersCreate.mockImplementation(async (_input: unknown) => ({ id: "cus_smoke_123" }))

  mockCheckoutSessionsCreate.mockReset()
  mockCheckoutSessionsCreate.mockImplementation(async (_input: unknown) => ({
    url: "https://checkout.stripe.test/session/cs_smoke_123",
  }))

  mockPortalSessionsCreate.mockReset()
  mockPortalSessionsCreate.mockImplementation(async (_input: unknown) => ({
    url: "https://billing.stripe.test/session/bps_smoke_123",
  }))

  mockConstructEvent.mockReset()
  mockConstructEvent.mockImplementation((body: string, signature: string, secret: string) => {
    if (signature !== "valid-signature") {
      throw new Error("invalid signature")
    }

    if (secret !== "whsec_smoke_test") {
      throw new Error("invalid webhook secret")
    }

    return JSON.parse(body)
  })

  mockSubscriptionsRetrieve.mockReset()
  mockSubscriptionsRetrieve.mockImplementation(async (subscriptionId: string, _input: unknown) => ({
    id: subscriptionId,
    items: {
      data: [
        {
          price: {
            metadata: {
              plan_tier: "pro",
            },
          },
        },
      ],
    },
  }))

  mockRequeuePlanLimitedDeployments.mockReset()
  mockRequeuePlanLimitedDeployments.mockImplementation(async (_org: unknown) => 0)
})

afterEach(async () => {
  await cleanupTestData()
})

afterAll(() => {
  mock.restore()
})

describe("billing smoke flow", () => {
  test("creates checkout and portal sessions and activates the org via webhook", async () => {
    const checkoutRes = await reqAs(adminCtx, `/api/orgs/${orgSlug}/billing/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priceId: "price_pro_smoke" }),
    })
    expect(checkoutRes.status).toBe(200)
    const checkoutBody = await checkoutRes.json() as { data: { url: string } }
    expect(checkoutBody.data.url).toBe("https://checkout.stripe.test/session/cs_smoke_123")

    expect(mockCustomersCreate).toHaveBeenCalledTimes(1)
    expect(mockCustomersCreate.mock.calls[0]?.[0]).toMatchObject({
      name: adminCtx.org.name,
      metadata: {
        orgId: adminCtx.org.id,
        orgSlug,
      },
    })

    const orgAfterCheckout = await getOrgRecord()
    expect(orgAfterCheckout?.stripeCustomerId).toBe("cus_smoke_123")

    expect(mockCheckoutSessionsCreate).toHaveBeenCalledTimes(1)
    expect(mockCheckoutSessionsCreate.mock.calls[0]?.[0]).toMatchObject({
      customer: "cus_smoke_123",
      mode: "subscription",
      line_items: [{ price: "price_pro_smoke", quantity: 1 }],
      success_url: `https://yaffle.local:6969/${orgSlug}/settings/billing?checkout=success`,
      cancel_url: `https://yaffle.local:6969/${orgSlug}/settings/billing?checkout=canceled`,
      metadata: {
        orgId: adminCtx.org.id,
        orgSlug,
      },
    })

    const portalRes = await reqAs(adminCtx, `/api/orgs/${orgSlug}/billing/portal`, {
      method: "POST",
    })
    expect(portalRes.status).toBe(200)
    const portalBody = await portalRes.json() as { data: { url: string } }
    expect(portalBody.data.url).toBe("https://billing.stripe.test/session/bps_smoke_123")

    expect(mockPortalSessionsCreate).toHaveBeenCalledTimes(1)
    expect(mockPortalSessionsCreate.mock.calls[0]?.[0]).toMatchObject({
      customer: "cus_smoke_123",
      return_url: `https://yaffle.local:6969/${orgSlug}/settings/billing`,
    })

    const webhookEvent = {
      id: "evt_checkout_completed_smoke",
      type: "checkout.session.completed",
      data: {
        object: {
          mode: "subscription",
          customer: "cus_smoke_123",
          subscription: "sub_smoke_123",
        },
      },
    }

    const webhookRes = await app.request("/api/webhooks/stripe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "valid-signature",
      },
      body: JSON.stringify(webhookEvent),
    })
    expect(webhookRes.status).toBe(200)
    const webhookBody = await webhookRes.json() as { received: boolean }
    expect(webhookBody.received).toBe(true)

    expect(mockConstructEvent).toHaveBeenCalledTimes(1)
    expect(mockSubscriptionsRetrieve).toHaveBeenCalledTimes(1)
    expect(mockSubscriptionsRetrieve.mock.calls[0]?.[0]).toBe("sub_smoke_123")

    const orgAfterWebhook = await getOrgRecord()
    expect(orgAfterWebhook?.subscriptionStatus).toBe("active")
    expect(orgAfterWebhook?.planTier).toBe("pro")

    expect(mockRequeuePlanLimitedDeployments).toHaveBeenCalledTimes(1)
    expect(mockRequeuePlanLimitedDeployments.mock.calls[0]?.[0]).toMatchObject({
      id: adminCtx.org.id,
      slug: orgSlug,
      subscriptionStatus: "active",
      planTier: "pro",
    })
  })

  test("rejects unauthorized billing actions and records payment failure states", async () => {
    const viewerCheckoutRes = await reqAs(viewerCtx, `/api/orgs/${orgSlug}/billing/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priceId: "price_pro_smoke" }),
    })
    expect(viewerCheckoutRes.status).toBe(403)
    const viewerCheckoutBody = await viewerCheckoutRes.json() as { error: { code: string } }
    expect(viewerCheckoutBody.error.code).toBe("FORBIDDEN")

    const portalWithoutCustomerRes = await reqAs(adminCtx, `/api/orgs/${orgSlug}/billing/portal`, {
      method: "POST",
    })
    expect(portalWithoutCustomerRes.status).toBe(400)
    const portalWithoutCustomerBody = await portalWithoutCustomerRes.json() as { error: { code: string } }
    expect(portalWithoutCustomerBody.error.code).toBe("NO_BILLING_ACCOUNT")

    const invalidCheckoutRes = await reqAs(adminCtx, `/api/orgs/${orgSlug}/billing/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priceId: "" }),
    })
    expect(invalidCheckoutRes.status).toBe(400)
    const invalidCheckoutBody = await invalidCheckoutRes.json() as { error: { code: string } }
    expect(invalidCheckoutBody.error.code).toBe("VALIDATION_ERROR")

    const missingSignatureRes = await app.request("/api/webhooks/stripe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "evt_missing_sig", type: "invoice.paid", data: { object: {} } }),
    })
    expect(missingSignatureRes.status).toBe(400)

    const invalidSignatureRes = await app.request("/api/webhooks/stripe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "bad-signature",
      },
      body: JSON.stringify({ id: "evt_bad_sig", type: "invoice.paid", data: { object: {} } }),
    })
    expect(invalidSignatureRes.status).toBe(400)

    await db
      .update(organizations)
      .set({ stripeCustomerId: "cus_smoke_123", subscriptionStatus: "active", planTier: "pro" })
      .where(eq(organizations.id, adminCtx.org.id))

    const paymentFailedEvent = {
      id: "evt_payment_failed_smoke",
      type: "invoice.payment_failed",
      data: {
        object: {
          customer: "cus_smoke_123",
        },
      },
    }

    const paymentFailedRes = await app.request("/api/webhooks/stripe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "valid-signature",
      },
      body: JSON.stringify(paymentFailedEvent),
    })
    expect(paymentFailedRes.status).toBe(200)

    const orgAfterFailure = await getOrgRecord()
    expect(orgAfterFailure?.subscriptionStatus).toBe("past_due")
    expect(orgAfterFailure?.planTier).toBe("pro")

    expect(mockRequeuePlanLimitedDeployments).not.toHaveBeenCalled()
  })
})
