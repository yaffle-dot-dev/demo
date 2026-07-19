import { describe, expect, test } from "@yaffle/test"

import { buildDestroyCommand, buildPlanCommand } from "./executor.ts"

describe("buildPlanCommand", () => {
  test("disables state locking for a merge-impact plan", () => {
    expect(buildPlanCommand({ lockState: false })).toEqual([
      "tofu",
      "plan",
      "-input=false",
      "-lock=false",
      "-out=tfplan",
      "-detailed-exitcode",
    ])
  })
})

describe("buildDestroyCommand", () => {
  test("waits for an existing state lock to be released", () => {
    expect(buildDestroyCommand()).toEqual([
      "tofu",
      "destroy",
      "-input=false",
      "-auto-approve",
      "-lock-timeout=5m",
    ])
  })
})
