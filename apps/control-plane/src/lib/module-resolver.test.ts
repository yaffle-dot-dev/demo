import { describe, expect, test } from "bun:test"

import { parsePreviewContext } from "./module-resolver.ts"

/**
 * Unit tests for the module resolver.
 *
 * Run with:
 *   bun test src/lib/module-resolver.test.ts
 */

describe("parsePreviewContext", () => {
  test("parses valid pr-{n} format", () => {
    const result = parsePreviewContext("pr-42")
    expect(result).toEqual({ prNumber: 42 })
  })

  test("parses PR-{n} (uppercase)", () => {
    const result = parsePreviewContext("PR-123")
    expect(result).toEqual({ prNumber: 123 })
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
