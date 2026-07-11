import { describe, expect, test } from "@yaffle/test"

import { environmentStatePrefix, transientStatePrefix } from "./runner.ts"

describe("transientStatePrefix", () => {
  test("encodes environment identity into one path segment", () => {
    expect(transientStatePrefix("review/team-42")).toBe("transient-review%2Fteam-42")
  })

  test("does not collide with a different environment and workspace boundary", () => {
    expect(transientStatePrefix("team/review")).not.toBe(transientStatePrefix("team"))
  })

  test("does not collide across environment kinds", () => {
    expect(transientStatePrefix("review-42")).not.toBe(environmentStatePrefix("review-42"))
  })
})
