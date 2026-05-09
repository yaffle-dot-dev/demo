import { describe, expect, test } from "@yaffle/test"

import { getRunGroupCheckSummary } from "./run-group-check-copy.ts"

describe("run-group-check-copy", () => {
  test("uses the standard copy on non-pirate days", () => {
    expect(getRunGroupCheckSummary("pending", new Date("2026-09-18T12:00:00"))).toBe(
      "Yaffle picked up this commit and is lining up your infrastructure changes.",
    )
  })

  test("uses pirate copy on september 19", () => {
    expect(getRunGroupCheckSummary("pending", new Date("2026-09-19T12:00:00"))).toBe(
      "Yaffle caught this commit and is charting your infrastructure changes, matey.",
    )

    expect(getRunGroupCheckSummary("failure", new Date("2026-09-19T12:00:00"))).toBe(
      "Yaffle hit rough seas while processing the infrastructure changes for this commit, matey.",
    )
  })
})
