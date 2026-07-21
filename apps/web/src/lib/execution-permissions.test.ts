import { describe, expect, test } from "@yaffle/test"

import { canMutateInfrastructure } from "./execution-permissions"

describe("canMutateInfrastructure", () => {
  test.each([
    ["viewer", false],
    ["approver", true],
    ["admin", true],
    [null, false],
  ] as const)("returns %s for %s", (role, expected) => {
    expect(canMutateInfrastructure(role)).toBe(expected)
  })
})
