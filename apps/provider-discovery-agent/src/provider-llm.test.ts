import { describe, expect, test } from "@yaffle/test"

import { extractProviderCredentialsWithLlm } from "./provider-llm"
import type { ProviderResearchMaterial } from "./types"

describe("extractProviderCredentialsWithLlm", () => {
  test("extracts and validates env vars from official docs", async () => {
    const calls: Array<{ model: string; input: unknown; options: unknown }> = []

    const material: ProviderResearchMaterial = {
      providerType: "hashicorp/tfe",
      details: {
        namespace: "hashicorp",
        name: "tfe",
        docs: [],
        source: "https://github.com/hashicorp/terraform-provider-tfe",
        tier: "official",
      },
      sources: [
        {
          kind: "terraform_registry",
          url: "https://registry.terraform.io/providers/hashicorp/tfe/latest/docs",
        },
      ],
      documents: [
        {
          kind: "github_repository_docs",
          url: "https://raw.githubusercontent.com/hashicorp/terraform-provider-tfe/main/website/docs/index.html.markdown",
          text: "Use TFE_TOKEN to authenticate. Set TFE_ADDRESS for your hostname.",
        },
      ],
    }

    const result = await extractProviderCredentialsWithLlm({
      AI: {
        run: async (model, input, options) => {
          calls.push({ model, input, options })
          return {
            response: JSON.stringify({
              exactEnvVars: ["TFE_TOKEN", "TFE_ADDRESS", "FAKE_TOKEN"],
              prefixEnvVars: ["TFE"],
              confidence: "high",
              reasoningSummary: "Official docs mention TFE_TOKEN and TFE_ADDRESS.",
            }),
          }
        },
      },
      YAFFLE_PROVIDER_DISCOVERY_AI_MODEL: "@cf/zai-org/glm-4.7-flash",
      YAFFLE_PROVIDER_DISCOVERY_AI_GATEWAY_ID: "provider-discovery-test",
    }, material)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.model).toBe("@cf/zai-org/glm-4.7-flash")
    expect(calls[0]?.options).toEqual({ gateway: { id: "provider-discovery-test", skipCache: false } })
    expect(result.exactEnvVars).toEqual(["TFE_TOKEN", "TFE_ADDRESS"])
    expect(result.prefixEnvVars).toEqual(["TFE_"])
    expect(result.confidence).toBe("high")
  })

  test("drops non-canonical env var identifiers from docs/codegen", async () => {
    const material: ProviderResearchMaterial = {
      providerType: "hashicorp/tfe",
      details: {
        namespace: "hashicorp",
        name: "tfe",
        docs: [],
      },
      sources: [],
      documents: [
        {
          kind: "github_repository_docs",
          url: "https://example.test/tfe",
          text: "Use TFE_TOKEN. CDKTF examples may show TfeToken or TFETOKEN in generated bindings.",
        },
      ],
    }

    const result = await extractProviderCredentialsWithLlm({
      AI: {
        run: async () => ({
          response: JSON.stringify({
            exactEnvVars: ["TFE_TOKEN", "TfeToken", "TFETOKEN"],
            prefixEnvVars: ["TFE_"],
            confidence: "high",
            reasoningSummary: "Canonical env var is TFE_TOKEN.",
          }),
        }),
      },
    }, material)

    expect(result.exactEnvVars).toEqual(["TFE_TOKEN"])
  })

  test("routes extraction through AI binding with gateway config", async () => {
    const calls: Array<{ model: string; input: unknown; options: unknown }> = []

    const material: ProviderResearchMaterial = {
      providerType: "hashicorp/tfe",
      details: {
        namespace: "hashicorp",
        name: "tfe",
        docs: [],
      },
      sources: [],
      documents: [
        {
          kind: "github_repository_docs",
          url: "https://raw.githubusercontent.com/hashicorp/terraform-provider-tfe/main/website/docs/index.html.markdown",
          text: "Use TFE_TOKEN to authenticate.",
        },
      ],
    }

    const result = await extractProviderCredentialsWithLlm({
      AI: {
        run: async (model, input, options) => {
          calls.push({ model, input, options })
          return {
            response: JSON.stringify({
              exactEnvVars: ["TFE_TOKEN"],
              prefixEnvVars: ["TFE_"],
              confidence: "high",
              reasoningSummary: "TFE_TOKEN is documented.",
            }),
          }
        },
      },
      YAFFLE_PROVIDER_DISCOVERY_AI_GATEWAY_ID: "yaffle-provider-discovery",
    }, material)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.options).toEqual({ gateway: { id: "yaffle-provider-discovery", skipCache: false } })
    expect(result.exactEnvVars).toEqual(["TFE_TOKEN"])
  })
})
