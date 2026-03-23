import { afterEach, describe, expect, test } from "bun:test"

import { getRunnerReachableTfcHost } from "./tfc-host.ts"

const ORIGINAL_RUNNER_TFC_API_HOST = process.env.YAFFLE_RUNNER_TFC_API_HOST
const ORIGINAL_RUNNER_API_URL = process.env.YAFFLE_RUNNER_API_URL
const ORIGINAL_TFC_API_HOST = process.env.YAFFLE_TFC_API_HOST

afterEach(() => {
  if (ORIGINAL_RUNNER_TFC_API_HOST === undefined) {
    delete process.env.YAFFLE_RUNNER_TFC_API_HOST
  } else {
    process.env.YAFFLE_RUNNER_TFC_API_HOST = ORIGINAL_RUNNER_TFC_API_HOST
  }

  if (ORIGINAL_RUNNER_API_URL === undefined) {
    delete process.env.YAFFLE_RUNNER_API_URL
  } else {
    process.env.YAFFLE_RUNNER_API_URL = ORIGINAL_RUNNER_API_URL
  }

  if (ORIGINAL_TFC_API_HOST === undefined) {
    delete process.env.YAFFLE_TFC_API_HOST
  } else {
    process.env.YAFFLE_TFC_API_HOST = ORIGINAL_TFC_API_HOST
  }
})

describe("getRunnerReachableTfcHost", () => {
  test("prefers explicit runner TFC host", () => {
    process.env.YAFFLE_RUNNER_TFC_API_HOST = "yaffle.tail66f312.ts.net:6969"
    process.env.YAFFLE_RUNNER_API_URL = "http://wrong-host:3000"
    process.env.YAFFLE_TFC_API_HOST = "wrong-local:6969"

    expect(getRunnerReachableTfcHost()).toBe("yaffle.tail66f312.ts.net:6969")
  })

  test("derives TFC host from runner API url", () => {
    delete process.env.YAFFLE_RUNNER_TFC_API_HOST
    process.env.YAFFLE_RUNNER_API_URL = "http://yaffle.tail66f312.ts.net:3000"
    process.env.YAFFLE_TFC_API_HOST = "yaffle.local:6969"

    expect(getRunnerReachableTfcHost()).toBe("yaffle.tail66f312.ts.net:6969")
  })
})
