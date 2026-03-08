import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { homedir } from "node:os"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"

import {
  configureLocalBackend,
  removeLocalState,
  resolveStateDir,
  resolveStatePath,
  stateExistsSync,
} from "./state.ts"

const STATE_ROOT = join(homedir(), ".yaffle", "state")

const TEST_OWNER = "test-state-owner"
const TEST_REPO = "test-state-repo"

/** Clean up test state after each test. */
afterEach(async () => {
  const testDir = join(STATE_ROOT, TEST_OWNER)
  await rm(testDir, { recursive: true, force: true })
})

describe("resolveStateDir", () => {
  test("returns directory containing the state file", () => {
    const dir = resolveStateDir(TEST_OWNER, TEST_REPO, "preview-pr-42/infra/terraform.tfstate")
    expect(dir).toBe(join(STATE_ROOT, TEST_OWNER, TEST_REPO, "preview-pr-42/infra"))
  })

  test("handles branch state key", () => {
    const dir = resolveStateDir(TEST_OWNER, TEST_REPO, "main/infra/terraform.tfstate")
    expect(dir).toBe(join(STATE_ROOT, TEST_OWNER, TEST_REPO, "main/infra"))
  })

  test("handles state key without subdirectory", () => {
    const dir = resolveStateDir(TEST_OWNER, TEST_REPO, "terraform.tfstate")
    expect(dir).toBe(join(STATE_ROOT, TEST_OWNER, TEST_REPO))
  })
})

describe("resolveStatePath", () => {
  test("returns full path to the state file", () => {
    const path = resolveStatePath(TEST_OWNER, TEST_REPO, "preview-pr-42/infra/terraform.tfstate")
    expect(path).toBe(
      join(STATE_ROOT, TEST_OWNER, TEST_REPO, "preview-pr-42/infra/terraform.tfstate"),
    )
  })
})

describe("configureLocalBackend", () => {
  test("creates state directory and writes backend_override.tf", async () => {
    const tmpDir = join(homedir(), ".yaffle", "state", TEST_OWNER, "_tmp_tf_dir")
    await mkdir(tmpDir, { recursive: true })

    try {
      const stateKey = "preview-pr-99/infra/terraform.tfstate"
      const returnedPath = await configureLocalBackend(tmpDir, TEST_OWNER, TEST_REPO, stateKey)

      // Returns the full state path
      const expectedStatePath = resolveStatePath(TEST_OWNER, TEST_REPO, stateKey)
      expect(returnedPath).toBe(expectedStatePath)

      // State directory was created
      const stateDir = resolveStateDir(TEST_OWNER, TEST_REPO, stateKey)
      expect(existsSync(stateDir)).toBe(true)

      // backend_override.tf was written with correct content
      const overridePath = join(tmpDir, "backend_override.tf")
      expect(existsSync(overridePath)).toBe(true)

      const content = await readFile(overridePath, "utf-8")
      expect(content).toContain('backend "local"')
      expect(content).toContain(`path = "${expectedStatePath}"`)
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})

describe("stateExistsSync", () => {
  test("returns false when no state file exists", () => {
    expect(stateExistsSync(TEST_OWNER, TEST_REPO, "preview-pr-0/infra/terraform.tfstate")).toBe(false)
  })

  test("returns true when state file exists", async () => {
    const stateKey = "preview-pr-77/infra/terraform.tfstate"
    const statePath = resolveStatePath(TEST_OWNER, TEST_REPO, stateKey)
    const stateDir = resolveStateDir(TEST_OWNER, TEST_REPO, stateKey)

    await mkdir(stateDir, { recursive: true })
    await writeFile(statePath, "{}")

    expect(stateExistsSync(TEST_OWNER, TEST_REPO, stateKey)).toBe(true)
  })
})

describe("removeLocalState", () => {
  test("removes the state directory", async () => {
    const stateKey = "preview-pr-55/infra/terraform.tfstate"
    const statePath = resolveStatePath(TEST_OWNER, TEST_REPO, stateKey)
    const stateDir = resolveStateDir(TEST_OWNER, TEST_REPO, stateKey)

    // Create a fake state file
    await mkdir(stateDir, { recursive: true })
    await writeFile(statePath, "{}")
    expect(existsSync(stateDir)).toBe(true)

    await removeLocalState(TEST_OWNER, TEST_REPO, stateKey)

    expect(existsSync(stateDir)).toBe(false)
  })

  test("does not throw when directory does not exist", async () => {
    // Should not throw
    await removeLocalState(TEST_OWNER, TEST_REPO, "preview-pr-0/infra/terraform.tfstate")
  })
})
