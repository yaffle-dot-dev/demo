import { z } from "zod"

import { type Job } from "../db/queries/jobs.ts"
import { getEnv } from "../lib/env.ts"
import { logger } from "../lib/telemetry.ts"

const providerDiscoveryPayloadSchema = z.object({
  providerType: z.string().min(1),
  providerSource: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  environment: z.string().min(1).optional(),
  workspacePath: z.string().min(1).optional(),
  requestedByOrgId: z.string().uuid(),
})

export function resolveProviderDiscoveryCallbackUrl(): string {
  const publicApiUrl = getEnv().publicApiUrl
  return `${publicApiUrl.replace(/\/$/, "")}/api/internal/provider-discovery/results`
}

export async function handleProviderDiscoveryJob(job: Job): Promise<void> {
  if (process.env.YAFFLE_PROVIDER_DISCOVERY_ENABLED !== "true") {
    logger.info("provider_discovery.disabled", { jobId: job.id })
    return
  }

  const endpoint = process.env.YAFFLE_PROVIDER_DISCOVERY_AGENT_ENDPOINT
  if (!endpoint) {
    throw new Error("YAFFLE_PROVIDER_DISCOVERY_AGENT_ENDPOINT is required when discovery is enabled")
  }

  const token = process.env.YAFFLE_PROVIDER_DISCOVERY_AGENT_TOKEN
  if (!token) {
    throw new Error("YAFFLE_PROVIDER_DISCOVERY_AGENT_TOKEN is required when discovery is enabled")
  }

  if (!process.env.YAFFLE_PROVIDER_DISCOVERY_CALLBACK_SECRET) {
    throw new Error("YAFFLE_PROVIDER_DISCOVERY_CALLBACK_SECRET is required when discovery is enabled")
  }

  const parsed = providerDiscoveryPayloadSchema.safeParse(job.payload)
  if (!parsed.success) {
    throw new Error(`Invalid provider_discovery payload for job ${job.id}`)
  }

  const payload = parsed.data
  const callbackUrl = resolveProviderDiscoveryCallbackUrl()
  const dispatchPayload = {
    requestId: job.id,
    providerType: payload.providerType,
    providerSource: payload.providerSource,
    repo: payload.repo,
    environment: payload.environment,
    workspacePath: payload.workspacePath,
    callbackUrl,
    callbackAuth: {
      mode: "hmac-sha256",
      secretRef: "YAFFLE_PROVIDER_DISCOVERY_CALLBACK_SECRET",
    },
    callbackTtlSeconds: 600,
  } as const

  logger.info("provider_discovery.dispatching", {
    jobId: job.id,
    providerType: payload.providerType,
    providerSource: payload.providerSource,
    repo: payload.repo,
    environment: payload.environment,
    workspacePath: payload.workspacePath,
    endpoint,
    callbackUrl,
  })

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(dispatchPayload),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Provider discovery dispatch failed (${response.status}): ${body}`)
  }

  logger.info("provider_discovery.dispatched", {
    jobId: job.id,
    providerType: payload.providerType,
    providerSource: payload.providerSource,
    repo: payload.repo,
    environment: payload.environment,
    workspacePath: payload.workspacePath,
    endpoint,
  })
}
