import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parsePlanSummary, runTerraform } from "./terraform.ts"

describe("parsePlanSummary", () => {
  test("parses standard plan output", () => {
    const output = `
Terraform will perform the following actions:

  # null_resource.example will be created
  + resource "null_resource" "example" {
      + id = (known after apply)
    }

Plan: 3 to add, 1 to change, 0 to destroy.
`
    expect(parsePlanSummary(output)).toBe("+3, ~1, -0")
  })

  test("parses no changes", () => {
    const output = `
No changes. Infrastructure is up-to-date.
`
    expect(parsePlanSummary(output)).toBe("no changes")
  })

  test("parses destroy-only plan", () => {
    const output = `
Plan: 0 to add, 0 to change, 5 to destroy.
`
    expect(parsePlanSummary(output)).toBe("+0, ~0, -5")
  })

  test("returns unknown for unrecognized output", () => {
    expect(parsePlanSummary("some random output")).toBe("unknown")
  })
})

describe("runTerraform", () => {
  let workDir: string

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true })
    }
  })

  test("plan succeeds with a simple null_resource", async () => {
    workDir = await mkdtemp(join(tmpdir(), "yaffle-tf-test-"))

    await Bun.write(
      join(workDir, "main.tf"),
      `
variable "environment" {
  type    = string
  default = "test"
}

resource "null_resource" "example" {
  triggers = {
    env = var.environment
  }
}
`,
    )

    const result = await runTerraform({
      workDir,
      command: "plan",
      variables: { environment: "preview-pr-1" },
    })

    expect(result.success).toBe(true)
    expect(result.command).toBe("plan")
    expect(result.planSummary).toBe("+1, ~0, -0")
    expect(result.output).toContain("null_resource")
    expect(result.planJson).toBeTruthy()
    expect(result.durationMs).toBeGreaterThan(0)
  }, 30_000)

  test("plan succeeds with no changes on empty config", async () => {
    workDir = await mkdtemp(join(tmpdir(), "yaffle-tf-test-"))

    await Bun.write(
      join(workDir, "main.tf"),
      `
terraform {
  required_version = ">= 1.0"
}
`,
    )

    const result = await runTerraform({
      workDir,
      command: "plan",
    })

    expect(result.success).toBe(true)
    expect(result.planSummary).toBe("no changes")
  }, 30_000)

  test("plan + apply + destroy lifecycle", async () => {
    workDir = await mkdtemp(join(tmpdir(), "yaffle-tf-test-"))

    await Bun.write(
      join(workDir, "main.tf"),
      `
resource "null_resource" "test" {
  triggers = {
    always = timestamp()
  }
}

output "test_id" {
  value = null_resource.test.id
}
`,
    )

    // Plan
    const planResult = await runTerraform({ workDir, command: "plan" })
    expect(planResult.success).toBe(true)
    expect(planResult.planSummary).toBe("+1, ~0, -0")

    // Apply
    const applyResult = await runTerraform({ workDir, command: "apply" })
    expect(applyResult.success).toBe(true)
    expect(applyResult.outputs).toBeTruthy()
    expect(applyResult.outputs?.test_id).toBeTruthy()

    // Destroy
    const destroyResult = await runTerraform({ workDir, command: "destroy" })
    expect(destroyResult.success).toBe(true)
  }, 60_000)

  test("plan fails with invalid terraform", async () => {
    workDir = await mkdtemp(join(tmpdir(), "yaffle-tf-test-"))

    await Bun.write(
      join(workDir, "main.tf"),
      `
resource "nonexistent_provider" "thing" {
  name = "this will fail"
}
`,
    )

    const result = await runTerraform({ workDir, command: "plan" })

    expect(result.success).toBe(false)
    expect(result.errorMessage).toBeTruthy()
    expect(result.durationMs).toBeGreaterThan(0)
  }, 30_000)
})
