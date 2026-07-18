import { describe, expect, test } from "@yaffle/test"

import { deployableLifecycleSteps, lifecycleWorkspaceWaitCondition } from "./converge"

describe("lifecycleWorkspaceWaitCondition", () => {
  test("activation waits for Terraform outputs, not usable readiness", () => {
    expect(lifecycleWorkspaceWaitCondition("activation")).toBe("outputs")
  })

  test("verification waits for usable readiness", () => {
    expect(lifecycleWorkspaceWaitCondition("verification")).toBe("usable")
  })
})

describe("deployableLifecycleSteps", () => {
  test("activation prepares before reading control-plane workspace outputs", () => {
    expect(deployableLifecycleSteps("activation")).toEqual([
      "prepare",
      "wait-for-workspaces",
      "build",
      "deploy",
    ])
  })

  test("verification waits for the deployment before checking it", () => {
    expect(deployableLifecycleSteps("verification")).toEqual(["wait-for-workspaces", "verify"])
  })
})
