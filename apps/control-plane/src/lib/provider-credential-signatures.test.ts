import { describe, expect, test } from "bun:test"

import { DEFAULT_PROVIDER_CREDENTIAL_SIGNATURES } from "./default-provider-credential-signatures.ts"
import { inferProviderTypeFromEnvVarKeysWithSignatures } from "./provider-credential-inference.ts"

describe("provider credential signature inference", () => {
  test("infers known providers from exact credential env vars", () => {
    expect(inferProviderTypeFromEnvVarKeysWithSignatures(["CLOUDFLARE_API_TOKEN"], {
      signatures: DEFAULT_PROVIDER_CREDENTIAL_SIGNATURES,
    }))
      .toBe("cloudflare")

    expect(inferProviderTypeFromEnvVarKeysWithSignatures(["DATABRICKS_HOST", "DATABRICKS_TOKEN"], {
      signatures: DEFAULT_PROVIDER_CREDENTIAL_SIGNATURES,
    }))
      .toBe("databricks")
  })

  test("infers provider from known prefixes", () => {
    expect(inferProviderTypeFromEnvVarKeysWithSignatures(["TAILSCALE_FOO", "TAILSCALE_BAR"], {
      signatures: DEFAULT_PROVIDER_CREDENTIAL_SIGNATURES,
    }))
      .toBe("tailscale")
  })

  test("returns generic when no known signals are present", () => {
    expect(inferProviderTypeFromEnvVarKeysWithSignatures(["TF_VAR_REGION", "CUSTOM_TOKEN"], {
      signatures: DEFAULT_PROVIDER_CREDENTIAL_SIGNATURES,
    }))
      .toBe("generic")
  })

  test("returns generic when provider score is ambiguous", () => {
    expect(inferProviderTypeFromEnvVarKeysWithSignatures(["GITHUB_TOKEN", "CLOUDFLARE_API_TOKEN"], {
      signatures: DEFAULT_PROVIDER_CREDENTIAL_SIGNATURES,
    }))
      .toBe("generic")
  })
})
