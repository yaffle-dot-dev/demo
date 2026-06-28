import { describe, expect, test } from "@yaffle/test"

import { lifecycleWorkspaceWaitCondition } from "./converge"

describe("lifecycleWorkspaceWaitCondition", () => {
  test("activation waits for Terraform outputs, not usable readiness", () => {
    expect(lifecycleWorkspaceWaitCondition("activation")).toBe("outputs")
  })

  test("verification waits for usable readiness", () => {
    expect(lifecycleWorkspaceWaitCondition("verification")).toBe("usable")
  })
})
