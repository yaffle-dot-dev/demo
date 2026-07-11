import { describe, expect, test } from "@yaffle/test"

import { parseTransientEnvironmentContext } from "./module-resolver.ts"

/**
 * Unit tests for the module resolver.
 *
 * Run with:
 *   pnpm exec vitest run src/lib/module-resolver.test.ts
 */

describe("parseTransientEnvironmentContext", () => {
  test("parses source-neutral environment names", () => {
    expect(parseTransientEnvironmentContext("review-42")).toEqual({
      environmentName: "review-42",
    })
  })

  test("parses GitHub pull-request environment names without extracting source metadata", () => {
    expect(parseTransientEnvironmentContext("pr-42")).toEqual({
      environmentName: "pr-42",
    })
  })

  test("preserves source-specific names other than GitHub pull requests", () => {
    expect(parseTransientEnvironmentContext("MR-123")).toEqual({
      environmentName: "MR-123",
    })
  })

  test("returns null for null input", () => {
    const result = parseTransientEnvironmentContext(null)
    expect(result).toBeNull()
  })

  test("returns null for empty string", () => {
    const result = parseTransientEnvironmentContext("")
    expect(result).toBeNull()
  })

  test("rejects names that are only whitespace", () => {
    expect(parseTransientEnvironmentContext("   ")).toBeNull()
  })
})
