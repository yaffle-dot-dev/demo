import { afterEach, describe, expect, mock, test } from "bun:test"

import {
  discoverProviderCredentials,
  extractCandidateEnvVarsFromText,
  inferPrefixEnvVars,
} from "./provider-research"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
})

describe("extractCandidateEnvVarsFromText", () => {
  test("extracts provider-specific credential variables", () => {
    const text = [
      "Set CLOUDFLARE_API_TOKEN to authenticate provider requests.",
      "You can also configure CLOUDFLARE_EMAIL and CLOUDFLARE_API_KEY.",
      "TF_LOG is optional for debug output.",
    ].join("\n")

    const extracted = extractCandidateEnvVarsFromText({
      text,
      providerType: "cloudflare",
    })

    expect(extracted.has("CLOUDFLARE_API_TOKEN")).toBe(true)
    expect(extracted.has("CLOUDFLARE_EMAIL")).toBe(true)
    expect(extracted.has("CLOUDFLARE_API_KEY")).toBe(true)
    expect(extracted.has("TF_LOG")).toBe(false)
  })
})

describe("inferPrefixEnvVars", () => {
  test("derives common provider prefix from exact vars", () => {
    const prefixes = inferPrefixEnvVars({
      providerType: "cloudflare",
      exactEnvVars: [
        "CLOUDFLARE_API_TOKEN",
        "CLOUDFLARE_API_KEY",
        "CLOUDFLARE_EMAIL",
      ],
    })

    expect(prefixes).toContain("CLOUDFLARE_")
  })

  test("handles multi-segment provider prefixes", () => {
    const prefixes = inferPrefixEnvVars({
      providerType: "newrelic",
      exactEnvVars: [
        "NEW_RELIC_API_KEY",
        "NEW_RELIC_ACCOUNT_ID",
        "NEW_RELIC_REGION",
      ],
    })

    expect(prefixes).toContain("NEW_RELIC_")
  })
})

describe("discoverProviderCredentials", () => {
  test("returns high-confidence env vars for a known provider", async () => {
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

      if (url === "https://registry.terraform.io/v1/providers?name=cloudflare") {
        return new Response(JSON.stringify({
          providers: [
            {
              namespace: "cloudflare",
              name: "cloudflare",
              source: "https://github.com/cloudflare/terraform-provider-cloudflare",
              tier: "official",
              downloads: 100,
            },
          ],
        }), { status: 200 })
      }

      if (url === "https://registry.terraform.io/v1/providers/cloudflare/cloudflare") {
        return new Response(JSON.stringify({
          namespace: "cloudflare",
          name: "cloudflare",
          source: "https://github.com/cloudflare/terraform-provider-cloudflare",
          tier: "official",
          docs: [
            {
              title: "Provider Overview",
              path: "docs/index.md",
              slug: "index",
              category: "overview",
            },
          ],
        }), { status: 200 })
      }

      if (url === "https://api.github.com/repos/cloudflare/terraform-provider-cloudflare") {
        return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 })
      }

      if (
        url === "https://raw.githubusercontent.com/cloudflare/terraform-provider-cloudflare/main/README.md"
        || url === "https://raw.githubusercontent.com/cloudflare/terraform-provider-cloudflare/main/docs/index.md"
      ) {
        return new Response([
          "Configure the cloudflare provider with CLOUDFLARE_API_TOKEN.",
          "Legacy auth supports CLOUDFLARE_EMAIL and CLOUDFLARE_API_KEY.",
        ].join("\n"), { status: 200 })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    const result = await discoverProviderCredentials({
      providerType: "cloudflare",
      timeoutMs: 5_000,
      maxDocs: 5,
    })

    expect(result.status).toBe("succeeded")
    expect(result.confidence).toBe("high")
    expect(result.exactEnvVars).toContain("CLOUDFLARE_API_TOKEN")
    expect(result.exactEnvVars).toContain("CLOUDFLARE_API_KEY")
    expect(result.exactEnvVars).toContain("CLOUDFLARE_EMAIL")
    expect(result.prefixEnvVars).toContain("CLOUDFLARE_")
    expect(result.sources.some((source) => source.kind === "terraform_registry")).toBe(true)
  })

  test("returns inconclusive when no provider exists in registry", async () => {
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

      if (url === "https://registry.terraform.io/v1/providers?name=notreal") {
        return new Response(JSON.stringify({ providers: [] }), { status: 200 })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    const result = await discoverProviderCredentials({
      providerType: "notreal",
      timeoutMs: 5_000,
      maxDocs: 5,
    })

    expect(result.status).toBe("inconclusive")
    expect(result.confidence).toBe("low")
    expect(result.exactEnvVars).toEqual([])
  })

  test("supports source-address provider identifiers", async () => {
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

      if (url === "https://registry.terraform.io/v1/providers/hashicorp/tfe") {
        return new Response(JSON.stringify({
          namespace: "hashicorp",
          name: "tfe",
          source: "https://github.com/hashicorp/terraform-provider-tfe",
          tier: "official",
          docs: [
            {
              title: "Provider Overview",
              path: "docs/index.md",
              slug: "index",
              category: "overview",
            },
          ],
        }), { status: 200 })
      }

      if (url === "https://api.github.com/repos/hashicorp/terraform-provider-tfe") {
        return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 })
      }

      if (url === "https://api.github.com/repos/hashicorp/terraform-provider-tfe/git/trees/main?recursive=1") {
        return new Response(JSON.stringify({
          tree: [
            {
              path: "website/docs/index.html.markdown",
              type: "blob",
            },
          ],
        }), { status: 200 })
      }

      if (
        url === "https://raw.githubusercontent.com/hashicorp/terraform-provider-tfe/main/README.md"
        || url === "https://raw.githubusercontent.com/hashicorp/terraform-provider-tfe/main/docs/index.md"
        || url === "https://raw.githubusercontent.com/hashicorp/terraform-provider-tfe/main/website/docs/index.html.markdown"
      ) {
        const body = url.endsWith("website/docs/index.html.markdown")
          ? [
              "Use TFE_TOKEN to authenticate.",
              "Set TFE_ADDRESS for your hostname.",
            ].join("\n")
          : "Provider overview"

        return new Response(body, { status: 200 })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    const result = await discoverProviderCredentials({
      providerType: "hashicorp/tfe",
      timeoutMs: 5_000,
      maxDocs: 5,
    })

    expect(result.status).toBe("succeeded")
    expect(result.exactEnvVars).toContain("TFE_TOKEN")
    expect(result.prefixEnvVars).toContain("TFE_")
  })
})
