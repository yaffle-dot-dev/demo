import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { cleanupWorkspace, findTerraformDirs } from "./workspace.ts"

describe("findTerraformDirs", () => {
  let workDir: string

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true })
    }
  })

  test("finds tf files in root directory", async () => {
    workDir = await mkdtemp(join(tmpdir(), "yaffle-ws-test-"))
    await Bun.write(join(workDir, "main.tf"), "resource {}")
    await Bun.write(join(workDir, "variables.tf"), "variable {}")

    const dirs = await findTerraformDirs(workDir)
    expect(dirs).toEqual(["."])
  })

  test("finds tf files in subdirectories", async () => {
    workDir = await mkdtemp(join(tmpdir(), "yaffle-ws-test-"))
    await Bun.write(join(workDir, "infra", "main.tf"), "resource {}")
    await Bun.write(join(workDir, "infra", "ecs.tf"), "resource {}")
    await Bun.write(join(workDir, "modules", "vpc", "main.tf"), "resource {}")

    const dirs = await findTerraformDirs(workDir)
    expect(dirs).toEqual(["infra", "modules/vpc"])
  })

  test("returns empty array when no tf files exist", async () => {
    workDir = await mkdtemp(join(tmpdir(), "yaffle-ws-test-"))
    await Bun.write(join(workDir, "README.md"), "hello")

    const dirs = await findTerraformDirs(workDir)
    expect(dirs).toEqual([])
  })
})

describe("cleanupWorkspace", () => {
  test("removes directory and contents", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "yaffle-ws-test-"))
    await Bun.write(join(workDir, "file.txt"), "data")

    await cleanupWorkspace(workDir)

    const exists = await Bun.file(join(workDir, "file.txt")).exists()
    expect(exists).toBe(false)
  })

  test("does not throw on missing directory", async () => {
    await cleanupWorkspace("/tmp/nonexistent-yaffle-ws-12345")
    // should not throw
  })
})
