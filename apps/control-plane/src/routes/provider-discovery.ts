import { Hono } from "hono"

import { findJobById } from "../db/queries/jobs.ts"
import {
  applyProviderDiscoveryResult,
  providerDiscoveryResultSchema,
} from "../lib/provider-discovery.ts"
import { verifyProviderDiscoveryCallbackSignature } from "../lib/provider-discovery-callback-auth.ts"
import { consumeProviderDiscoveryCallbackNonce } from "../lib/provider-discovery-callback-replay.ts"
import { logger } from "../lib/telemetry.ts"

export const providerDiscoveryRoute = new Hono()

providerDiscoveryRoute.post("/results", async (c) => {
  const secret = process.env.YAFFLE_PROVIDER_DISCOVERY_CALLBACK_SECRET ?? ""
  if (!secret) {
    return c.json(
      {
        error: {
          code: "PROVIDER_DISCOVERY_CALLBACK_SECRET_NOT_CONFIGURED",
          message: "Provider discovery callback secret is not configured",
        },
      },
      503,
    )
  }

  const body = await c.req.text()
  const verified = await verifyProviderDiscoveryCallbackSignature({
    body,
    timestampHeader: c.req.header("x-yaffle-timestamp"),
    nonceHeader: c.req.header("x-yaffle-nonce"),
    signatureHeader: c.req.header("x-yaffle-signature"),
    secret,
  })

  if (!verified) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid provider discovery callback signature" } },
      401,
    )
  }

  const nonceAccepted = consumeProviderDiscoveryCallbackNonce(c.req.header("x-yaffle-nonce"))
  if (!nonceAccepted) {
    return c.json(
      { error: { code: "REPLAY_DETECTED", message: "Provider discovery callback replay detected" } },
      409,
    )
  }

  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return c.json(
      { error: { code: "BAD_REQUEST", message: "Request body must be valid JSON" } },
      400,
    )
  }
  const parsed = providerDiscoveryResultSchema.safeParse(payload)
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: "Invalid provider discovery callback payload",
          details: parsed.error.issues,
        },
      },
      400,
    )
  }

  const result = parsed.data
  const job = await findJobById(result.requestId)
  if (!job) {
    return c.json({ error: { code: "NOT_FOUND", message: "Discovery request not found" } }, 404)
  }

  if (job.jobType !== "provider_discovery") {
    return c.json(
      { error: { code: "CONFLICT", message: "Request ID does not reference a provider discovery job" } },
      409,
    )
  }

  const payloadProviderType = typeof job.payload === "object" && job.payload !== null
    ? (job.payload as Record<string, unknown>).providerType
    : undefined
  const normalizedPayloadProviderType = typeof payloadProviderType === "string"
    ? payloadProviderType.trim().toLowerCase()
    : ""
  const normalizedResultProviderType = result.providerType.trim().toLowerCase()

  if (normalizedPayloadProviderType && normalizedPayloadProviderType !== normalizedResultProviderType) {
    return c.json(
      { error: { code: "CONFLICT", message: "Provider type mismatch for discovery request" } },
      409,
    )
  }

  try {
    await applyProviderDiscoveryResult(result)
  } catch (error) {
    logger.error("provider_discovery.callback_apply_failed", {
      requestId: result.requestId,
      providerType: result.providerType,
      error: error instanceof Error ? error.message : String(error),
    })
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Failed to apply discovery result" } }, 500)
  }

  return c.json({ data: { accepted: true } }, 202)
})
