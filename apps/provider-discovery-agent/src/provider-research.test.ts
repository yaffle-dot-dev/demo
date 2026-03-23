import { describe, expect, test } from "bun:test"

import {
  extractCandidateEnvVarsFromText,
  inferPrefixEnvVars,
} from "./provider-research"

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
