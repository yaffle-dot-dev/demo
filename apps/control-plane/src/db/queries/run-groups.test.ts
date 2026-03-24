import { describe, expect, test } from "bun:test"

import { deriveRunGroupStatusFromRunStatuses } from "./run-groups.ts"

describe("deriveRunGroupStatusFromRunStatuses", () => {
  test("returns pending when all runs are pending", () => {
    expect(deriveRunGroupStatusFromRunStatuses(["pending", "pending"])).toEqual({
      status: "pending",
      isComplete: false,
    })
  })

  test("returns running when any run is running", () => {
    expect(deriveRunGroupStatusFromRunStatuses(["running", "failed"])).toEqual({
      status: "running",
      isComplete: false,
    })
  })

  test("returns success when all runs succeeded or were skipped", () => {
    expect(deriveRunGroupStatusFromRunStatuses(["success", "skipped", "success"])).toEqual({
      status: "success",
      isComplete: true,
    })
  })

  test("returns failed when a run fails and no runs are still running", () => {
    expect(deriveRunGroupStatusFromRunStatuses(["failed", "pending"])).toEqual({
      status: "failed",
      isComplete: true,
    })
  })

  test("treats system_error as failed", () => {
    expect(deriveRunGroupStatusFromRunStatuses(["system_error", "success"])).toEqual({
      status: "failed",
      isComplete: true,
    })
  })

  test("returns partial for terminal mixes without failures", () => {
    expect(deriveRunGroupStatusFromRunStatuses(["success", "cancelled"])).toEqual({
      status: "partial",
      isComplete: true,
    })
  })

  test("returns running for non-terminal mixes without failures", () => {
    expect(deriveRunGroupStatusFromRunStatuses(["success", "pending"])).toEqual({
      status: "running",
      isComplete: false,
    })
  })
})
