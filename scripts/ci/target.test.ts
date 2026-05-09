import { test, expect } from "@yaffle/test"

import { parseYaffleToml } from "../../apps/control-plane/src/lib/config-toml"

import { createTarget } from "./target"
import { discoverDeployables } from "./deployables/discovery"
import { planDeployables } from "./deployables/planner"

import {
  buildPrEnvironmentName,
  findPushTriggerEnvironment,
  matchesPullRequestTrigger,
} from "../../apps/control-plane/src/lib/config-toml"

const config = parseYaffleToml(`
version = 1

[[environments]]
name = "main"

[[cloud.triggers.github.push]]
ref_patterns = ["refs/heads/main"]
environment = "main"

[[cloud.triggers.github.pull_request]]
branch_patterns = ["*"]

[[workspaces]]
path = "apps/control-plane/infra"
environments = ["*"]
`)

test("resolves push refs to named environments", () => {
  expect(findPushTriggerEnvironment(config, "refs/heads/main")).toBe("main")
})

test("resolves pull requests to transient environments", () => {
  expect(matchesPullRequestTrigger(config, "feature/foo")).toBe(true)
  expect(buildPrEnvironmentName(42)).toBe("pr-42")
})

test("creates manual targets", () => {
  expect(createTarget({
    environmentKind: "named",
    environmentName: "main",
    sha: "abc123",
  })).toEqual({
    environment: {
      kind: "named",
      name: "main",
    },
    git: {
      sha: "abc123",
      baseSha: undefined,
      ref: undefined,
      branch: undefined,
      prNumber: undefined,
    },
    source: {
      kind: "manual",
      event: "manual",
    },
  })
})

test("discovers colocated deployable descriptors", async () => {
  const deployables = await discoverDeployables()

  expect(deployables.map((item) => item.name)).toContain("control-plane")
  expect(deployables.map((item) => item.name)).toContain("traffic-controller")
})

test("plans changed deployables and marks unsupported targets", async () => {
  const deployables = await discoverDeployables()
  const plan = planDeployables({
    deployables,
    environmentKind: "transient",
    changedFiles: [
      "apps/runner/src/scanner-lambda.ts",
      "apps/traffic-controller/src/api-lambda.ts",
    ],
  })

  expect(plan.selected.map((item) => item.name)).toEqual(["runner", "scanner"])
  expect(plan.entries.find((entry) => entry.name === "traffic-controller")?.status).toBe(
    "unsupported_for_target",
  )
})
