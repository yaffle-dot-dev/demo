import { afterEach, describe, expect, test } from "@yaffle/test"

import { getRunnerCredentialHosts, getRunnerReachableTfcHost } from "./tfc-host.ts"

const ORIGINAL_RUNNER_TFC_API_HOST = process.env.YAFFLE_RUNNER_TFC_API_HOST
const ORIGINAL_MODULE_SOURCE_ALLOWED_HOSTS = process.env.YAFFLE_MODULE_SOURCE_ALLOWED_HOSTS

afterEach(() => {
  if (ORIGINAL_RUNNER_TFC_API_HOST === undefined) {
    delete process.env.YAFFLE_RUNNER_TFC_API_HOST
  } else {
    process.env.YAFFLE_RUNNER_TFC_API_HOST = ORIGINAL_RUNNER_TFC_API_HOST
  }

  if (ORIGINAL_MODULE_SOURCE_ALLOWED_HOSTS === undefined) {
    delete process.env.YAFFLE_MODULE_SOURCE_ALLOWED_HOSTS
  } else {
    process.env.YAFFLE_MODULE_SOURCE_ALLOWED_HOSTS = ORIGINAL_MODULE_SOURCE_ALLOWED_HOSTS
  }
})

describe("getRunnerReachableTfcHost", () => {
  test("returns configured TFC host", () => {
    process.env.YAFFLE_RUNNER_TFC_API_HOST = "yaffle.tail66f312.ts.net:6969"

    expect(getRunnerReachableTfcHost()).toBe("yaffle.tail66f312.ts.net:6969")
  })

  test("throws when not configured", () => {
    delete process.env.YAFFLE_RUNNER_TFC_API_HOST

    expect(() => getRunnerReachableTfcHost()).toThrow(
      "YAFFLE_RUNNER_TFC_API_HOST must be configured",
    )
  })
})

describe("getRunnerCredentialHosts", () => {
  test("includes runner host and public registry hosts", () => {
    process.env.YAFFLE_RUNNER_TFC_API_HOST = "cp.internal.yaffle.dev"
    process.env.YAFFLE_MODULE_SOURCE_ALLOWED_HOSTS = "yaffle.dev,.ts.net"

    expect(getRunnerCredentialHosts()).toEqual(["cp.internal.yaffle.dev", "yaffle.dev"])
  })
})
