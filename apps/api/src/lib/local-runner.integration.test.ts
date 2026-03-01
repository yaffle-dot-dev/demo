import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { configureLocalBackend, removeState, stateExists } from "./state.ts"
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
    await removeState(OWNER, REPO, STATE_KEY)
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
    expect(stateExists(OWNER, REPO, STATE_KEY)).toBe(true)

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
    await removeState(OWNER, REPO, STATE_KEY)
    expect(stateExists(OWNER, REPO, STATE_KEY)).toBe(false)

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
