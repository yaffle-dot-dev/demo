import { describe, expect, test } from "@yaffle/test"

import { getMergeImpactRunTokenScopes } from "./run-token.ts"

describe("getMergeImpactRunTokenScopes", () => {
  test("cannot lock or write named environment state", () => {
    expect(getMergeImpactRunTokenScopes()).toEqual([
      "workspace:read",
      "state:read",
      "state:download",
    ])
  })
})
