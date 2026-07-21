import { z } from "zod"

export const discoveryDispatchRequestSchema = z.object({
  requestId: z.string().uuid(),
  providerType: z.string().min(1),
  providerSource: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  environment: z.string().min(1).optional(),
  workspacePath: z.string().min(1).optional(),
  callbackUrl: z.string().url(),
  callbackAuth: z
    .object({
      mode: z.literal("hmac-sha256"),
      secretRef: z.string().min(1).optional(),
    })
    .optional(),
  callbackTtlSeconds: z.number().int().min(1).max(3600).optional(),
})

export type DiscoveryDispatchRequest = z.infer<typeof discoveryDispatchRequestSchema>

export const discoveryCallbackStatusSchema = z.enum(["succeeded", "failed", "inconclusive"])
export type DiscoveryCallbackStatus = z.infer<typeof discoveryCallbackStatusSchema>

export const discoveryResultConfidenceSchema = z.enum(["high", "medium", "low"])
export type DiscoveryResultConfidence = z.infer<typeof discoveryResultConfidenceSchema>

export const discoverySourceSchema = z.object({
  url: z.string().url(),
  kind: z.string().min(1),
})

export type DiscoverySource = z.infer<typeof discoverySourceSchema>

export interface DiscoveryResultPayload {
  requestId: string
  status: DiscoveryCallbackStatus
  providerType: string
  displayName?: string
  suggestedCredentialProviderType?: "envvar" | "iam_role"
  exactEnvVars: string[]
  prefixEnvVars: string[]
  confidence: DiscoveryResultConfidence
  sources: DiscoverySource[]
  reasoningSummary: string
}

export interface ProviderDiscoveryRunResult {
  status: DiscoveryCallbackStatus
  confidence: DiscoveryResultConfidence
  displayName?: string
  exactEnvVars: string[]
  prefixEnvVars: string[]
  sources: DiscoverySource[]
  reasoningSummary: string
}

export interface ProviderCandidate {
  namespace: string
  name: string
  source?: string
  tier?: string
  downloads?: number
}

export interface ProviderRegistryDoc {
  title: string
  path: string
  slug: string
  category: string
}

export interface ProviderDetails {
  namespace: string
  name: string
  description?: string
  source?: string
  tier?: string
  docs: ProviderRegistryDoc[]
}

export interface ProviderDocument {
  url: string
  kind: string
  text: string
}

export interface ProviderResearchMaterial {
  providerType: string
  details: ProviderDetails
  sources: DiscoverySource[]
  documents: ProviderDocument[]
}

export interface ProviderCredentialExtractionResult {
  exactEnvVars: string[]
  prefixEnvVars: string[]
  confidence: DiscoveryResultConfidence
  reasoningSummary: string
}

export interface DiscoveryRequestAccepted {
  accepted: true
  requestId: string
}
