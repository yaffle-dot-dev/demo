import { describe, expect, test } from "@yaffle/test"

import { getDeploymentExecutionEnvironment } from "./deployment-environment.ts"

describe("getDeploymentExecutionEnvironment", () => {
  test("preserves a source-neutral transient identity without PR metadata", () => {
    expect(
      getDeploymentExecutionEnvironment({
        environmentKind: "transient",
        environmentName: "review-42",
        prNumber: null,
      }),
    ).toEqual({
      environmentKind: "transient",
      environmentName: "review-42",
      sourcePrNumber: null,
    })
  })

  test("does not derive identity from optional GitHub metadata", () => {
    expect(
      getDeploymentExecutionEnvironment({
        environmentKind: "named",
        environmentName: "pr-42",
        prNumber: 42,
      }),
    ).toEqual({
      environmentKind: "named",
      environmentName: "pr-42",
      sourcePrNumber: 42,
    })
  })
})
