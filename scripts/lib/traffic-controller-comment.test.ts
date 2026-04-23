import { describe, expect, test } from "bun:test"

import {
  buildDefaultDeploymentId,
  parseTrafficControllerComment,
} from "./traffic-controller-comment"

describe("traffic-controller PR comment parser", () => {
  test("parses create route commands with this preview target", () => {
    expect(parseTrafficControllerComment(
      "/yaffle create route pull_request opened on lamalex/aoc to this preview",
    )).toEqual({
      desiredState: "active",
      event: "pull_request",
      action: "opened",
      repositoryOwner: "lamalex",
      repositoryName: "aoc",
      target: "this_preview",
    })
  })

  test("parses destroy route commands with explicit deployment id", () => {
    expect(parseTrafficControllerComment(
      "/yaffle destroy route push on lamalex/aoc from dep-pr-7-lamalex",
    )).toEqual({
      desiredState: "absent",
      event: "push",
      action: undefined,
      repositoryOwner: "lamalex",
      repositoryName: "aoc",
      target: { deploymentId: "dep-pr-7-lamalex" },
    })
  })

  test("still parses legacy key=value commands", () => {
    expect(parseTrafficControllerComment(
      "/yaffle lease ensure deployment=dep-pr7-lamalex event=pull_request repo=lamalex/aoc action=opened",
    )).toEqual({
      desiredState: "active",
      event: "pull_request",
      action: "opened",
      repositoryOwner: "lamalex",
      repositoryName: "aoc",
      target: { deploymentId: "dep-pr7-lamalex" },
    })
  })

  test("builds a deterministic default deployment id for this preview", () => {
    expect(buildDefaultDeploymentId({ prNumber: 7, actorLogin: "lamalex" })).toBe("dep-pr-7-lamalex")
  })
})
