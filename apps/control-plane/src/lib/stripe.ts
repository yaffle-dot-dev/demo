import Stripe from "stripe"

let _stripe: Stripe | null = null

/**
 * Get the Stripe client singleton.
 * Reads STRIPE_API_KEY from the environment.
 * Returns null if no key is configured (e.g. dev without Stripe).
 */
export function getStripe(): Stripe | null {
  if (_stripe) return _stripe

  const apiKey = process.env.STRIPE_API_KEY
  if (!apiKey) return null

  _stripe = new Stripe(apiKey)
  return _stripe
}

/**
 * Get the Stripe client, throwing if not configured.
 * Use this in endpoints that require Stripe.
 */
export function requireStripe(): Stripe {
  const stripe = getStripe()
  if (!stripe) {
    throw new Error("Stripe is not configured (STRIPE_API_KEY not set)")
  }
  return stripe
}
