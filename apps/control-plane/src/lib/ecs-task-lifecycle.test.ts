import { describe, expect, test } from "bun:test"

import { isEcsTaskDrainingOrStopping } from "./ecs-task-lifecycle.ts"

describe("isEcsTaskDrainingOrStopping", () => {
  test("returns false for running task", () => {
    expect(isEcsTaskDrainingOrStopping({
      DesiredStatus: "RUNNING",
      KnownStatus: "RUNNING",
    })).toBe(false)
  })

  test("returns true when desired status is stopped", () => {
    expect(isEcsTaskDrainingOrStopping({
      DesiredStatus: "STOPPED",
      KnownStatus: "RUNNING",
    })).toBe(true)
  })

  test("returns true when known status is deprovisioning", () => {
    expect(isEcsTaskDrainingOrStopping({
      DesiredStatus: "RUNNING",
      KnownStatus: "DEPROVISIONING",
    })).toBe(true)
  })

  test("handles lowercase metadata keys", () => {
    expect(isEcsTaskDrainingOrStopping({
      desiredStatus: "running",
      knownStatus: "stopping",
    })).toBe(true)
  })
})
