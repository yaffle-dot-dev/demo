import { describe, expect, test } from "bun:test"

import { isStaleScanJob } from "./scan-job-staleness.ts"

describe("isStaleScanJob", () => {
  const now = new Date("2026-04-09T00:20:00Z")

  test("treats old queued jobs with no heartbeat as stale", () => {
    expect(
      isStaleScanJob({
        status: "queued",
        queuedAt: new Date("2026-04-09T00:18:00Z"),
        startedAt: null,
        lastHeartbeat: null,
      }, 60_000, now),
    ).toBe(true)
  })

  test("does not treat recently queued jobs as stale", () => {
    expect(
      isStaleScanJob({
        status: "queued",
        queuedAt: new Date("2026-04-09T00:19:30Z"),
        startedAt: null,
        lastHeartbeat: null,
      }, 60_000, now),
    ).toBe(false)
  })

  test("treats running jobs with stale heartbeats as stale", () => {
    expect(
      isStaleScanJob({
        status: "running",
        queuedAt: new Date("2026-04-09T00:10:00Z"),
        startedAt: new Date("2026-04-09T00:11:00Z"),
        lastHeartbeat: new Date("2026-04-09T00:18:30Z"),
      }, 60_000, now),
    ).toBe(true)
  })

  test("treats recently heartbeating running jobs as healthy", () => {
    expect(
      isStaleScanJob({
        status: "running",
        queuedAt: new Date("2026-04-09T00:10:00Z"),
        startedAt: new Date("2026-04-09T00:11:00Z"),
        lastHeartbeat: new Date("2026-04-09T00:19:30Z"),
      }, 60_000, now),
    ).toBe(false)
  })

  test("never treats terminal jobs as stale", () => {
    expect(
      isStaleScanJob({
        status: "failed",
        queuedAt: new Date("2026-04-09T00:10:00Z"),
        startedAt: new Date("2026-04-09T00:11:00Z"),
        lastHeartbeat: new Date("2026-04-09T00:12:00Z"),
      }, 60_000, now),
    ).toBe(false)
  })
})
