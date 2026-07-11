import { describe, expect, test } from "@yaffle/test"

import { getEnvironmentKind, parseYaffleToml } from "./config-toml.ts"

describe("getEnvironmentKind", () => {
  const config = parseYaffleToml(`
version = 1

[[environments]]
name = "pr-42"

[[workspaces]]
path = "infra"
environments = ["pr-42"]
`)

  test("uses configuration rather than interpreting the environment name", () => {
    expect(getEnvironmentKind(config, "pr-42")).toBe("named")
    expect(getEnvironmentKind(config, "review-42")).toBe("transient")
  })
})
