import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { homedir } from "node:os"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"

import {
  type BackendConfig,
  configureBackend,
  configureLocalBackend,
  configureS3Backend,
  removeState,
  resolveS3StateKey,
  resolveStateDir,
  resolveStatePath,
  stateExists,
  stateExistsSync,
} from "./state.ts"

const STATE_ROOT = join(homedir(), ".yaffle", "state")

const TEST_OWNER = "test-state-owner"
const TEST_REPO = "test-state-repo"

// Force local backend for tests
const LOCAL_CONFIG: BackendConfig = { mode: "local" }

/** Clean up test state after each test. */
afterEach(async () => {
  const testDir = join(STATE_ROOT, TEST_OWNER)
  await rm(testDir, { recursive: true, force: true })
})

describe("resolveStateDir", () => {
  test("returns directory containing the state file", () => {
    const dir = resolveStateDir(TEST_OWNER, TEST_REPO, "previews/pr-42/terraform.tfstate")
    expect(dir).toBe(join(STATE_ROOT, TEST_OWNER, TEST_REPO, "previews/pr-42"))
  })

  test("handles production state key", () => {
    const dir = resolveStateDir(TEST_OWNER, TEST_REPO, "production/main/terraform.tfstate")
    expect(dir).toBe(join(STATE_ROOT, TEST_OWNER, TEST_REPO, "production/main"))
  })

  test("handles state key without subdirectory", () => {
    const dir = resolveStateDir(TEST_OWNER, TEST_REPO, "terraform.tfstate")
    expect(dir).toBe(join(STATE_ROOT, TEST_OWNER, TEST_REPO))
  })
})

describe("resolveStatePath", () => {
  test("returns full path to the state file", () => {
    const path = resolveStatePath(TEST_OWNER, TEST_REPO, "previews/pr-42/terraform.tfstate")
    expect(path).toBe(
      join(STATE_ROOT, TEST_OWNER, TEST_REPO, "previews/pr-42/terraform.tfstate"),
    )
  })
})

describe("resolveS3StateKey", () => {
  test("builds S3 key from owner/repo/stateKey", () => {
    const key = resolveS3StateKey("acme", "webapp", "previews/pr-42/terraform.tfstate")
    expect(key).toBe("acme/webapp/previews/pr-42/terraform.tfstate")
  })

  test("handles production state key", () => {
    const key = resolveS3StateKey("acme", "webapp", "production/main/terraform.tfstate")
    expect(key).toBe("acme/webapp/production/main/terraform.tfstate")
  })
})

describe("configureLocalBackend", () => {
  test("creates state directory and writes backend_override.tf", async () => {
    const tmpDir = join(homedir(), ".yaffle", "state", TEST_OWNER, "_tmp_tf_dir")
    await mkdir(tmpDir, { recursive: true })

    try {
      const stateKey = "previews/pr-99/terraform.tfstate"
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

describe("configureS3Backend", () => {
  test("writes backend_override.tf with S3 configuration", async () => {
    const tmpDir = join(homedir(), ".yaffle", "state", TEST_OWNER, "_tmp_tf_dir_s3")
    await mkdir(tmpDir, { recursive: true })

    try {
      const stateKey = "previews/pr-99/terraform.tfstate"
      const s3Config = {
        bucket: "yaffle-state-test",
        region: "us-east-1",
        dynamodbTable: "yaffle-locks",
      }

      const returnedKey = await configureS3Backend(
        tmpDir,
        TEST_OWNER,
        TEST_REPO,
        stateKey,
        s3Config,
      )

      // Returns the S3 key
      expect(returnedKey).toBe(`${TEST_OWNER}/${TEST_REPO}/${stateKey}`)

      // backend_override.tf was written with correct content
      const overridePath = join(tmpDir, "backend_override.tf")
      expect(existsSync(overridePath)).toBe(true)

      const content = await readFile(overridePath, "utf-8")
      expect(content).toContain('backend "s3"')
      expect(content).toContain(`bucket         = "${s3Config.bucket}"`)
      expect(content).toContain(`key            = "${returnedKey}"`)
      expect(content).toContain(`region         = "${s3Config.region}"`)
      expect(content).toContain(`dynamodb_table = "${s3Config.dynamodbTable}"`)
      expect(content).toContain("encrypt        = true")
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})

describe("configureBackend", () => {
  test("uses local backend when config mode is local", async () => {
    const tmpDir = join(homedir(), ".yaffle", "state", TEST_OWNER, "_tmp_tf_unified")
    await mkdir(tmpDir, { recursive: true })

    try {
      const stateKey = "previews/pr-88/terraform.tfstate"
      const returnedPath = await configureBackend(
        tmpDir,
        TEST_OWNER,
        TEST_REPO,
        stateKey,
        LOCAL_CONFIG,
      )

      // Should return local path
      const expectedStatePath = resolveStatePath(TEST_OWNER, TEST_REPO, stateKey)
      expect(returnedPath).toBe(expectedStatePath)

      // backend_override.tf should have local backend
      const overridePath = join(tmpDir, "backend_override.tf")
      const content = await readFile(overridePath, "utf-8")
      expect(content).toContain('backend "local"')
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  test("uses S3 backend when config mode is s3", async () => {
    const tmpDir = join(homedir(), ".yaffle", "state", TEST_OWNER, "_tmp_tf_unified_s3")
    await mkdir(tmpDir, { recursive: true })

    try {
      const stateKey = "previews/pr-88/terraform.tfstate"
      const s3Config: BackendConfig = {
        mode: "s3",
        s3: {
          bucket: "yaffle-state-unified",
          region: "us-west-2",
          dynamodbTable: "yaffle-locks-unified",
        },
      }

      const returnedKey = await configureBackend(
        tmpDir,
        TEST_OWNER,
        TEST_REPO,
        stateKey,
        s3Config,
      )

      // Should return S3 key
      expect(returnedKey).toBe(`${TEST_OWNER}/${TEST_REPO}/${stateKey}`)

      // backend_override.tf should have S3 backend
      const overridePath = join(tmpDir, "backend_override.tf")
      const content = await readFile(overridePath, "utf-8")
      expect(content).toContain('backend "s3"')
      expect(content).toContain("yaffle-state-unified")
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})

describe("stateExists (local)", () => {
  test("returns false when no state file exists", async () => {
    const exists = await stateExists(
      TEST_OWNER,
      TEST_REPO,
      "previews/pr-0/terraform.tfstate",
      LOCAL_CONFIG,
    )
    expect(exists).toBe(false)
  })

  test("returns true when state file exists", async () => {
    const stateKey = "previews/pr-77/terraform.tfstate"
    const statePath = resolveStatePath(TEST_OWNER, TEST_REPO, stateKey)
    const stateDir = resolveStateDir(TEST_OWNER, TEST_REPO, stateKey)

    await mkdir(stateDir, { recursive: true })
    await writeFile(statePath, "{}")

    const exists = await stateExists(TEST_OWNER, TEST_REPO, stateKey, LOCAL_CONFIG)
    expect(exists).toBe(true)
  })
})

describe("stateExistsSync (deprecated)", () => {
  test("returns false when no state file exists", () => {
    expect(stateExistsSync(TEST_OWNER, TEST_REPO, "previews/pr-0/terraform.tfstate")).toBe(false)
  })

  test("returns true when state file exists", async () => {
    const stateKey = "previews/pr-77/terraform.tfstate"
    const statePath = resolveStatePath(TEST_OWNER, TEST_REPO, stateKey)
    const stateDir = resolveStateDir(TEST_OWNER, TEST_REPO, stateKey)

    await mkdir(stateDir, { recursive: true })
    await writeFile(statePath, "{}")

    expect(stateExistsSync(TEST_OWNER, TEST_REPO, stateKey)).toBe(true)
  })
})

describe("removeState (local)", () => {
  test("removes the state directory", async () => {
    const stateKey = "previews/pr-55/terraform.tfstate"
    const statePath = resolveStatePath(TEST_OWNER, TEST_REPO, stateKey)
    const stateDir = resolveStateDir(TEST_OWNER, TEST_REPO, stateKey)

    // Create a fake state file
    await mkdir(stateDir, { recursive: true })
    await writeFile(statePath, "{}")
    expect(existsSync(stateDir)).toBe(true)

    await removeState(TEST_OWNER, TEST_REPO, stateKey, LOCAL_CONFIG)

    expect(existsSync(stateDir)).toBe(false)
  })

  test("does not throw when directory does not exist", async () => {
    // Should not throw
    await removeState(TEST_OWNER, TEST_REPO, "previews/pr-0/terraform.tfstate", LOCAL_CONFIG)
  })
})
