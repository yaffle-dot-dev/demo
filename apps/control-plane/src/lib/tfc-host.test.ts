import { afterEach, describe, expect, test } from "bun:test"

import { getRunnerReachableTfcHost } from "./tfc-host.ts"

const ORIGINAL_RUNNER_TFC_API_HOST = process.env.YAFFLE_RUNNER_TFC_API_HOST

afterEach(() => {
  if (ORIGINAL_RUNNER_TFC_API_HOST === undefined) {
    delete process.env.YAFFLE_RUNNER_TFC_API_HOST
  } else {
    process.env.YAFFLE_RUNNER_TFC_API_HOST = ORIGINAL_RUNNER_TFC_API_HOST
  }
})

describe("getRunnerReachableTfcHost", () => {
  test("returns configured TFC host", () => {
    process.env.YAFFLE_RUNNER_TFC_API_HOST = "yaffle.tail66f312.ts.net:6969"

    expect(getRunnerReachableTfcHost()).toBe("yaffle.tail66f312.ts.net:6969")
  })

  test("throws when not configured", () => {
    delete process.env.YAFFLE_RUNNER_TFC_API_HOST

    expect(() => getRunnerReachableTfcHost()).toThrow("YAFFLE_RUNNER_TFC_API_HOST must be configured")
  })
})
