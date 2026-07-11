import { describe, expect, test } from "@yaffle/test"

import { parsePreviewContext } from "./module-resolver.ts"

/**
 * Unit tests for the module resolver.
 *
 * Run with:
 *   pnpm exec vitest run src/lib/module-resolver.test.ts
 */

describe("parsePreviewContext", () => {
  test("parses valid pr-{n} format", () => {
    const result = parsePreviewContext("pr-42")
    expect(result).toEqual({ prNumber: 42 })
  })

  test("rejects uppercase PR-{n} aliases", () => {
    expect(parsePreviewContext("PR-123")).toBeNull()
  })

  test("rejects noncanonical PR numbers", () => {
    expect(parsePreviewContext("pr-0")).toBeNull()
    expect(parsePreviewContext("pr-01")).toBeNull()
    expect(parsePreviewContext("pr-999999999999999999999")).toBeNull()
  })

  test("returns null for null input", () => {
    const result = parsePreviewContext(null)
    expect(result).toBeNull()
  })

  test("returns null for empty string", () => {
    const result = parsePreviewContext("")
    expect(result).toBeNull()
  })

  test("returns null for invalid format", () => {
    expect(parsePreviewContext("42")).toBeNull()
    expect(parsePreviewContext("preview-42")).toBeNull()
    expect(parsePreviewContext("pr-")).toBeNull()
    expect(parsePreviewContext("pr-abc")).toBeNull()
  })
})
