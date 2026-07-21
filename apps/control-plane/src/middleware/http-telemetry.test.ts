import { describe, expect, test } from "@yaffle/test"

import { redactHttpUrl } from "./http-telemetry.ts"

describe("redactHttpUrl", () => {
  test("redacts state upload capabilities from paths and telemetry URLs", () => {
    const redacted = redactHttpUrl(
      "https://api.yaffle.dev/tfc/api/v2/state-versions/state-id/upload/super-secret-token",
    )

    expect(redacted.path).toBe("/tfc/api/v2/state-versions/state-id/upload/:capability")
    expect(redacted.url).not.toContain("super-secret-token")
  })

  test("redacts bearer capabilities from query parameters", () => {
    const redacted = redactHttpUrl(
      "https://api.yaffle.dev/module/archive.tar.gz?token=super-secret-token&environment=main",
    )

    expect(redacted.url).not.toContain("super-secret-token")
    expect(redacted.url).toContain("token=%3Acapability")
    expect(redacted.url).toContain("environment=main")
  })
})
