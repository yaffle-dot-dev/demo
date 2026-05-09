import { afterEach, describe, expect, test } from "@yaffle/test"

import {
  clearProviderDiscoveryCallbackNonceCacheForTests,
  consumeProviderDiscoveryCallbackNonce,
} from "./provider-discovery-callback-replay.ts"

afterEach(() => {
  clearProviderDiscoveryCallbackNonceCacheForTests()
})

describe("consumeProviderDiscoveryCallbackNonce", () => {
  test("accepts a nonce once", () => {
    const now = Date.now()
    expect(consumeProviderDiscoveryCallbackNonce("nonce-1", now)).toBe(true)
  })

  test("rejects replayed nonce within ttl", () => {
    const now = Date.now()
    expect(consumeProviderDiscoveryCallbackNonce("nonce-1", now)).toBe(true)
    expect(consumeProviderDiscoveryCallbackNonce("nonce-1", now + 1_000)).toBe(false)
  })

  test("accepts nonce again after ttl", () => {
    const now = Date.now()
    expect(consumeProviderDiscoveryCallbackNonce("nonce-1", now)).toBe(true)
    expect(consumeProviderDiscoveryCallbackNonce("nonce-1", now + (6 * 60 * 1000))).toBe(true)
  })
})
