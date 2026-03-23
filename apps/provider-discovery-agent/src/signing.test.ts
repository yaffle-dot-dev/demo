import { describe, expect, test } from "bun:test"

import { buildSignedCallbackHeaders } from "./signing"

describe("buildSignedCallbackHeaders", () => {
  test("includes timestamp nonce and signature headers", async () => {
    const headers = new Headers(await buildSignedCallbackHeaders({
      body: "{}",
      secret: "abc123",
      timestampMs: 1_700_000_000_000,
      nonce: "nonce-1",
    }))

    expect(headers.get("x-yaffle-timestamp")).toBe("1700000000000")
    expect(headers.get("x-yaffle-nonce")).toBe("nonce-1")
    expect(headers.get("x-yaffle-signature")?.startsWith("sha256=")).toBe(true)
  })
})
