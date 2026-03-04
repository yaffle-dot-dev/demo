import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { LocalRunner } from "./local-runner.ts"
import { type BackendConfig, configureLocalBackend, removeState, stateExists } from "./state.ts"

// Force local backend for tests
const LOCAL_CONFIG: BackendConfig = { mode: "local" }
import { runTerraform } from "./terraform.ts"

const TF_CONFIG = `
resource "null_resource" "example" {
  triggers = {
    value = "hello"
  }
}

output "resource_id" {
  value = null_resource.example.id
}
`

const OWNER = "integration-test"
const REPO = "persistent-state"
const STATE_KEY = "previews/pr-100/terraform.tfstate"

/**
 * Helper: create a fresh work directory with main.tf, configure the persistent
 * backend, and return the path. This simulates what LocalRunner does on each
 * invocation: clone repo, write backend override, run tofu.
 */
async function freshWorkDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yaffle-integration-"))
  await writeFile(join(dir, "main.tf"), TF_CONFIG)
  await configureLocalBackend(dir, OWNER, REPO, STATE_KEY)
  return dir
}

describe("persistent state integration", () => {
  const workDirs: string[] = []

  afterAll(async () => {
    // Clean up temp dirs
    for (const dir of workDirs) {
      await rm(dir, { recursive: true, force: true })
    }
    // Clean up persistent state
    await removeState(OWNER, REPO, STATE_KEY, LOCAL_CONFIG)
  })

  test("plan -> apply -> plan (no changes) -> destroy lifecycle with persistent state", async () => {
    // 1. Plan in fresh workspace -- should show 1 to add
    const planDir = await freshWorkDir()
    workDirs.push(planDir)

    const planResult = await runTerraform({
      workDir: planDir,
      command: "plan",
    })
    expect(planResult.success).toBe(true)
    expect(planResult.planSummary).toBe("+1, ~0, -0")

    // State file should NOT exist yet (plan doesn't write state)
    // (local backend creates the file but with no resources in it)

    // 2. Apply in a DIFFERENT fresh workspace -- proves state persists
    const applyDir = await freshWorkDir()
    workDirs.push(applyDir)

    const applyResult = await runTerraform({
      workDir: applyDir,
      command: "apply",
    })
    expect(applyResult.success).toBe(true)
    expect(applyResult.outputs).toBeTruthy()
    expect(applyResult.outputs?.resource_id).toBeTruthy()

    // State file should now exist
    expect(await stateExists(OWNER, REPO, STATE_KEY, LOCAL_CONFIG)).toBe(true)

    // 3. Plan again in yet another fresh workspace -- should show no changes
    //    This is the critical assertion: state from apply persists across workspaces
    const replanDir = await freshWorkDir()
    workDirs.push(replanDir)

    const replanResult = await runTerraform({
      workDir: replanDir,
      command: "plan",
    })
    expect(replanResult.success).toBe(true)
    expect(replanResult.planSummary).toBe("no changes")

    // 4. Destroy in another fresh workspace
    const destroyDir = await freshWorkDir()
    workDirs.push(destroyDir)

    const destroyResult = await runTerraform({
      workDir: destroyDir,
      command: "destroy",
    })
    expect(destroyResult.success).toBe(true)

    // 5. Clean up persistent state (like the handler does)
    await removeState(OWNER, REPO, STATE_KEY, LOCAL_CONFIG)
    expect(await stateExists(OWNER, REPO, STATE_KEY, LOCAL_CONFIG)).toBe(false)

    // 6. Plan one more time -- should show 1 to add again (state is gone)
    const finalPlanDir = await freshWorkDir()
    workDirs.push(finalPlanDir)

    const finalPlanResult = await runTerraform({
      workDir: finalPlanDir,
      command: "plan",
    })
    expect(finalPlanResult.success).toBe(true)
    expect(finalPlanResult.planSummary).toBe("+1, ~0, -0")
  }, 120_000)
})

describe("LocalRunner", () => {
  test("returns clear error when workspace path does not exist in repo", async () => {
    const runner = new LocalRunner()

    // Use the real repo (yaffle itself) but point at a nonexistent workspace path
    const result = await runner.run({
      owner: "lamalex",
      repo: "yaffle",
      headSha: "HEAD",
      command: "plan",
      workspacePath: "this/path/does/not/exist",
      stateKey: "previews/pr-999/this/path/does/not/exist/terraform.tfstate",
    })

    expect(result.success).toBe(false)
    expect(result.errorMessage).toContain("this/path/does/not/exist")
    expect(result.errorMessage).toContain("not found")
    expect(result.errorMessage).toContain(".yaffle/config.yml")
    // Should NOT contain internal temp paths
    expect(result.errorMessage).not.toContain("/var/folders")
    expect(result.errorMessage).not.toContain("yaffle-ws-")
  }, 30_000)
})
