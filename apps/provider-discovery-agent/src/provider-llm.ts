import type {
  DiscoveryResultConfidence,
  ProviderCredentialExtractionResult,
  ProviderResearchMaterial,
} from "./types"

const MODEL_DEFAULT = "@cf/zai-org/glm-4.7-flash"
const MAX_DOCUMENT_CHARS = 12_000
const MAX_TOTAL_CHARS = 48_000

interface AiBinding {
  run: (model: string, input: unknown, options?: unknown) => Promise<unknown>
}

interface LlmEnv {
  AI: AiBinding
  YAFFLE_PROVIDER_DISCOVERY_AI_MODEL?: string
  YAFFLE_PROVIDER_DISCOVERY_AI_GATEWAY_ID?: string
}

interface LlmExtractionResponse {
  exactEnvVars?: string[]
  prefixEnvVars?: string[]
  confidence?: DiscoveryResultConfidence
  reasoningSummary?: string
}

function buildDocumentBundle(material: ProviderResearchMaterial): string {
  let totalChars = 0
  const sections: string[] = []

  for (const document of material.documents) {
    if (totalChars >= MAX_TOTAL_CHARS) {
      break
    }

    const remaining = MAX_TOTAL_CHARS - totalChars
    const text = document.text.slice(0, Math.min(MAX_DOCUMENT_CHARS, remaining))
    if (!text.trim()) {
      continue
    }

    sections.push([`SOURCE: ${document.kind}`, `URL: ${document.url}`, "CONTENT:", text].join("\n"))

    totalChars += text.length
  }

  return sections.join("\n\n---\n\n")
}

function normalizeEnvVar(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "")
}

function isCanonicalEnvVar(value: string): boolean {
  return /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(value)
}

function normalizePrefix(value: string): string {
  const prefix = normalizeEnvVar(value)
  if (!prefix) {
    return ""
  }

  return prefix.endsWith("_") ? prefix : `${prefix}_`
}

function buildResponseSchema(): Record<string, unknown> {
  return {
    name: "provider_credential_extraction",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        exactEnvVars: {
          type: "array",
          items: { type: "string" },
        },
        prefixEnvVars: {
          type: "array",
          items: { type: "string" },
        },
        confidence: {
          type: "string",
          enum: ["high", "medium", "low"],
        },
        reasoningSummary: {
          type: "string",
        },
      },
      required: ["exactEnvVars", "prefixEnvVars", "confidence", "reasoningSummary"],
    },
  }
}

function parseLlmJson(raw: unknown): LlmExtractionResponse {
  if (typeof raw === "string") {
    return JSON.parse(raw) as LlmExtractionResponse
  }

  if (raw && typeof raw === "object") {
    return raw as LlmExtractionResponse
  }

  throw new Error("LLM returned an unexpected response payload")
}

function extractMessageContent(response: unknown): LlmExtractionResponse {
  if (response && typeof response === "object") {
    const asRecord = response as Record<string, unknown>

    if (typeof asRecord.response === "string") {
      return parseLlmJson(asRecord.response)
    }

    const choices = asRecord.choices
    if (Array.isArray(choices)) {
      const message =
        choices[0] && typeof choices[0] === "object"
          ? (choices[0] as Record<string, unknown>).message
          : undefined
      if (message && typeof message === "object") {
        const content = (message as Record<string, unknown>).content
        if (typeof content === "string") {
          return parseLlmJson(content)
        }
      }
    }
  }

  throw new Error("LLM response did not include parseable content")
}

function validateAgainstDocuments(
  material: ProviderResearchMaterial,
  extracted: LlmExtractionResponse,
): ProviderCredentialExtractionResult {
  const corpus = material.documents.map((document) => document.text.toUpperCase()).join("\n")

  const exactEnvVars = [
    ...new Set(
      (extracted.exactEnvVars ?? [])
        .map(normalizeEnvVar)
        .filter((value) => value.length > 0 && corpus.includes(value))
        .filter(isCanonicalEnvVar),
    ),
  ]

  const prefixEnvVars = [
    ...new Set(
      (extracted.prefixEnvVars ?? [])
        .map(normalizePrefix)
        .filter(
          (value) =>
            value.length > 1 &&
            (corpus.includes(value) || exactEnvVars.some((envVar) => envVar.startsWith(value))),
        ),
    ),
  ]

  const confidence = extracted.confidence ?? "low"
  const reasoningSummary =
    extracted.reasoningSummary?.trim() ||
    `Extracted credentials from official provider docs for ${material.providerType}.`

  return {
    exactEnvVars,
    prefixEnvVars,
    confidence,
    reasoningSummary,
  }
}

export async function extractProviderCredentialsWithLlm(
  env: LlmEnv,
  material: ProviderResearchMaterial,
): Promise<ProviderCredentialExtractionResult> {
  const documentBundle = buildDocumentBundle(material)
  if (!documentBundle.trim()) {
    return {
      exactEnvVars: [],
      prefixEnvVars: [],
      confidence: "low",
      reasoningSummary: `No official documents were available to analyze for ${material.providerType}.`,
    }
  }

  const requestBody = {
    messages: [
      {
        role: "system",
        content: [
          "You extract Terraform provider authentication environment variables from official provider documentation.",
          "Only return variables that appear verbatim in the provided documents.",
          "Prefer auth-related variables over general configuration.",
          "Return concise JSON only.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `Provider source: ${material.details.namespace}/${material.details.name}`,
          `Requested provider type: ${material.providerType}`,
          "Extract the exact environment variables used for authentication, optional auth-related prefixes, and confidence.",
          "Documents:",
          documentBundle,
        ].join("\n\n"),
      },
    ],
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: buildResponseSchema(),
    },
  }

  const model = env.YAFFLE_PROVIDER_DISCOVERY_AI_MODEL || MODEL_DEFAULT
  console.log("provider_discovery.llm.request", {
    providerType: material.providerType,
    providerSource: `${material.details.namespace}/${material.details.name}`,
    model,
    gatewayId: env.YAFFLE_PROVIDER_DISCOVERY_AI_GATEWAY_ID ?? null,
    documentCount: material.documents.length,
    sourceCount: material.sources.length,
  })

  const response = await env.AI.run(
    model,
    requestBody,
    env.YAFFLE_PROVIDER_DISCOVERY_AI_GATEWAY_ID
      ? {
          gateway: {
            id: env.YAFFLE_PROVIDER_DISCOVERY_AI_GATEWAY_ID,
            skipCache: false,
          },
        }
      : undefined,
  )

  console.log("provider_discovery.llm.response_received", {
    providerType: material.providerType,
    model,
  })

  return validateAgainstDocuments(material, extractMessageContent(response))
}
