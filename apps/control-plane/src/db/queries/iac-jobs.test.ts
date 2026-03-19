import { describe, expect, test } from "bun:test"

/**
 * Tests for the job priority sorting logic used in findQueuedJobsForSpawning.
 *
 * The actual database integration is tested via the scheduler integration tests.
 * These unit tests verify the sorting algorithm in isolation.
 */

// Replicate the priority function from iac-jobs.ts
const jobTypePriority = (type: string): number => {
  switch (type) {
    case "apply": return 0
    case "destroy": return 1
    case "plan": return 2
    default: return 3
  }
}

interface MockJob {
  id: string
  jobType: string
  queuedAt: string
  runGroupId: string
}

function sortJobsByPriority(jobs: MockJob[]): MockJob[] {
  return [...jobs].sort((a, b) => {
    const priorityDiff = jobTypePriority(a.jobType) - jobTypePriority(b.jobType)
    if (priorityDiff !== 0) return priorityDiff
    return new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime()
  })
}

describe("iac-jobs priority sorting", () => {
  test("applies are prioritized over plans within the same group", () => {
    const jobs: MockJob[] = [
      { id: "plan-1", jobType: "plan", queuedAt: "2024-01-01T00:00:00Z", runGroupId: "group-a" },
      { id: "apply-1", jobType: "apply", queuedAt: "2024-01-01T00:01:00Z", runGroupId: "group-a" },
      { id: "plan-2", jobType: "plan", queuedAt: "2024-01-01T00:02:00Z", runGroupId: "group-a" },
    ]

    const sorted = sortJobsByPriority(jobs)

    expect(sorted.map((j) => j.id)).toEqual(["apply-1", "plan-1", "plan-2"])
  })

  test("applies are sorted by queue time among themselves", () => {
    const jobs: MockJob[] = [
      { id: "apply-2", jobType: "apply", queuedAt: "2024-01-01T00:02:00Z", runGroupId: "group-a" },
      { id: "apply-1", jobType: "apply", queuedAt: "2024-01-01T00:01:00Z", runGroupId: "group-a" },
      { id: "apply-3", jobType: "apply", queuedAt: "2024-01-01T00:03:00Z", runGroupId: "group-a" },
    ]

    const sorted = sortJobsByPriority(jobs)

    expect(sorted.map((j) => j.id)).toEqual(["apply-1", "apply-2", "apply-3"])
  })

  test("plans are sorted by queue time among themselves", () => {
    const jobs: MockJob[] = [
      { id: "plan-3", jobType: "plan", queuedAt: "2024-01-01T00:03:00Z", runGroupId: "group-a" },
      { id: "plan-1", jobType: "plan", queuedAt: "2024-01-01T00:01:00Z", runGroupId: "group-a" },
      { id: "plan-2", jobType: "plan", queuedAt: "2024-01-01T00:02:00Z", runGroupId: "group-a" },
    ]

    const sorted = sortJobsByPriority(jobs)

    expect(sorted.map((j) => j.id)).toEqual(["plan-1", "plan-2", "plan-3"])
  })

  test("destroy jobs have priority between apply and plan", () => {
    const jobs: MockJob[] = [
      { id: "plan-1", jobType: "plan", queuedAt: "2024-01-01T00:00:00Z", runGroupId: "group-a" },
      { id: "destroy-1", jobType: "destroy", queuedAt: "2024-01-01T00:01:00Z", runGroupId: "group-a" },
      { id: "apply-1", jobType: "apply", queuedAt: "2024-01-01T00:02:00Z", runGroupId: "group-a" },
    ]

    const sorted = sortJobsByPriority(jobs)

    // apply > destroy > plan
    expect(sorted.map((j) => j.id)).toEqual(["apply-1", "destroy-1", "plan-1"])
  })

  test("mixed job types are sorted correctly", () => {
    const jobs: MockJob[] = [
      { id: "plan-1", jobType: "plan", queuedAt: "2024-01-01T00:00:00Z", runGroupId: "group-a" },
      { id: "apply-1", jobType: "apply", queuedAt: "2024-01-01T00:01:00Z", runGroupId: "group-a" },
      { id: "plan-2", jobType: "plan", queuedAt: "2024-01-01T00:02:00Z", runGroupId: "group-a" },
      { id: "apply-2", jobType: "apply", queuedAt: "2024-01-01T00:03:00Z", runGroupId: "group-a" },
      { id: "destroy-1", jobType: "destroy", queuedAt: "2024-01-01T00:04:00Z", runGroupId: "group-a" },
    ]

    const sorted = sortJobsByPriority(jobs)

    // All applies first (by queue time), then destroys, then plans (by queue time)
    expect(sorted.map((j) => j.id)).toEqual([
      "apply-1", "apply-2",  // applies sorted by queue time
      "destroy-1",           // destroy
      "plan-1", "plan-2",    // plans sorted by queue time
    ])
  })

  test("an apply queued later still has priority over earlier plans", () => {
    // This is the key behavior: user approves an apply, it should jump ahead
    // of queued plans for the same run group
    const jobs: MockJob[] = [
      { id: "plan-1", jobType: "plan", queuedAt: "2024-01-01T00:00:00Z", runGroupId: "group-a" },
      { id: "plan-2", jobType: "plan", queuedAt: "2024-01-01T00:01:00Z", runGroupId: "group-a" },
      { id: "plan-3", jobType: "plan", queuedAt: "2024-01-01T00:02:00Z", runGroupId: "group-a" },
      // User approves apply 5 minutes later
      { id: "apply-1", jobType: "apply", queuedAt: "2024-01-01T00:05:00Z", runGroupId: "group-a" },
    ]

    const sorted = sortJobsByPriority(jobs)

    // Apply should be first despite being queued last
    expect(sorted[0].id).toBe("apply-1")
    expect(sorted.map((j) => j.id)).toEqual(["apply-1", "plan-1", "plan-2", "plan-3"])
  })
})

describe("round-robin with group-local priority", () => {
  /**
   * Simulates the round-robin scheduling algorithm from findQueuedJobsForSpawning,
   * where each group's jobs are sorted by priority before round-robin selection.
   */
  function simulateRoundRobinClaim(
    jobsByGroup: Map<string, MockJob[]>,
    maxToClaim: number,
  ): string[] {
    const claimed: string[] = []
    const groupIds = Array.from(jobsByGroup.keys())
    const groupIndices = new Map<string, number>()

    // Sort each group by priority
    for (const [groupId, jobs] of jobsByGroup) {
      jobsByGroup.set(groupId, sortJobsByPriority(jobs))
      groupIndices.set(groupId, 0)
    }

    let madeProgress = true
    while (madeProgress && claimed.length < maxToClaim) {
      madeProgress = false

      for (const groupId of groupIds) {
        if (claimed.length >= maxToClaim) break

        const jobs = jobsByGroup.get(groupId)!
        const idx = groupIndices.get(groupId)!

        if (idx >= jobs.length) continue

        claimed.push(jobs[idx].id)
        groupIndices.set(groupId, idx + 1)
        madeProgress = true
      }
    }

    return claimed
  }

  test("applies from group B do not skip plans from group A", () => {
    const jobsByGroup = new Map<string, MockJob[]>([
      ["group-a", [
        { id: "a-plan-1", jobType: "plan", queuedAt: "2024-01-01T00:00:00Z", runGroupId: "group-a" },
        { id: "a-plan-2", jobType: "plan", queuedAt: "2024-01-01T00:01:00Z", runGroupId: "group-a" },
      ]],
      ["group-b", [
        { id: "b-apply-1", jobType: "apply", queuedAt: "2024-01-01T00:02:00Z", runGroupId: "group-b" },
        { id: "b-plan-1", jobType: "plan", queuedAt: "2024-01-01T00:03:00Z", runGroupId: "group-b" },
      ]],
    ])

    const claimed = simulateRoundRobinClaim(jobsByGroup, 4)

    // Round-robin: group-a first, then group-b, alternating
    // Group A: plan-1, plan-2 (no applies to prioritize)
    // Group B: apply-1 (prioritized), plan-1
    expect(claimed).toEqual([
      "a-plan-1",   // round 1: group-a's first job (plan, no applies)
      "b-apply-1",  // round 1: group-b's first job (apply prioritized)
      "a-plan-2",   // round 2: group-a's second job
      "b-plan-1",   // round 2: group-b's second job
    ])
  })

  test("applies within same group are prioritized over plans", () => {
    const jobsByGroup = new Map<string, MockJob[]>([
      ["group-a", [
        { id: "a-plan-1", jobType: "plan", queuedAt: "2024-01-01T00:00:00Z", runGroupId: "group-a" },
        { id: "a-apply-1", jobType: "apply", queuedAt: "2024-01-01T00:01:00Z", runGroupId: "group-a" },
        { id: "a-plan-2", jobType: "plan", queuedAt: "2024-01-01T00:02:00Z", runGroupId: "group-a" },
      ]],
    ])

    const claimed = simulateRoundRobinClaim(jobsByGroup, 3)

    // Within group-a: apply should come first despite being queued second
    expect(claimed).toEqual(["a-apply-1", "a-plan-1", "a-plan-2"])
  })

  test("fair round-robin is maintained across groups with mixed priorities", () => {
    const jobsByGroup = new Map<string, MockJob[]>([
      ["group-a", [
        { id: "a-plan-1", jobType: "plan", queuedAt: "2024-01-01T00:00:00Z", runGroupId: "group-a" },
        { id: "a-apply-1", jobType: "apply", queuedAt: "2024-01-01T00:05:00Z", runGroupId: "group-a" },
      ]],
      ["group-b", [
        { id: "b-plan-1", jobType: "plan", queuedAt: "2024-01-01T00:01:00Z", runGroupId: "group-b" },
      ]],
      ["group-c", [
        { id: "c-apply-1", jobType: "apply", queuedAt: "2024-01-01T00:02:00Z", runGroupId: "group-c" },
        { id: "c-plan-1", jobType: "plan", queuedAt: "2024-01-01T00:03:00Z", runGroupId: "group-c" },
      ]],
    ])

    const claimed = simulateRoundRobinClaim(jobsByGroup, 5)

    // Round-robin through groups, but within each group applies come first
    expect(claimed).toEqual([
      "a-apply-1",  // group-a: apply prioritized over plan
      "b-plan-1",   // group-b: only has plan
      "c-apply-1",  // group-c: apply prioritized over plan
      "a-plan-1",   // group-a: now the plan
      "c-plan-1",   // group-c: now the plan (group-b exhausted)
    ])
  })
})
