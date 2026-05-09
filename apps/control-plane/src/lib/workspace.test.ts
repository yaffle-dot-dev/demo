import { afterEach, describe, expect, test } from "@yaffle/test"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
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
    await writeFile(join(workDir, "main.tf"), "resource {}")
    await writeFile(join(workDir, "variables.tf"), "variable {}")

    const dirs = await findTerraformDirs(workDir)
    expect(dirs).toEqual(["."])
  })

  test("finds tf files in subdirectories", async () => {
    workDir = await mkdtemp(join(tmpdir(), "yaffle-ws-test-"))
    await writeFile(join(workDir, "infra", "main.tf"), "resource {}")
    await writeFile(join(workDir, "infra", "ecs.tf"), "resource {}")
    await writeFile(join(workDir, "modules", "vpc", "main.tf"), "resource {}")

    const dirs = await findTerraformDirs(workDir)
    expect(dirs).toEqual(["infra", "modules/vpc"])
  })

  test("returns empty array when no tf files exist", async () => {
    workDir = await mkdtemp(join(tmpdir(), "yaffle-ws-test-"))
    await writeFile(join(workDir, "README.md"), "hello")

    const dirs = await findTerraformDirs(workDir)
    expect(dirs).toEqual([])
  })
})

describe("cleanupWorkspace", () => {
  test("removes directory and contents", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "yaffle-ws-test-"))
    await writeFile(join(workDir, "file.txt"), "data")

    await cleanupWorkspace(workDir)

    await expect(access(join(workDir, "file.txt"), fsConstants.F_OK)).rejects.toThrow()
  })

  test("does not throw on missing directory", async () => {
    await cleanupWorkspace("/tmp/nonexistent-yaffle-ws-12345")
    // should not throw
  })
})
