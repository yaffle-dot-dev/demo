import { afterAll, describe, expect, test } from "@yaffle/test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { LocalRunner } from "./local-runner.ts"
import { configureLocalBackend, removeLocalState, stateExistsSync } from "./state.ts"
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
const STATE_KEY = "preview-pr-100/infra/terraform.tfstate"

/**
 * Helper: create a fresh work directory with main.tf, configure the persistent
 * local backend, and return the path. This simulates what the local backend
 * does in dev mode.
 */
async function freshWorkDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yaffle-integration-"))
  await writeFile(join(dir, "main.tf"), TF_CONFIG)
  await configureLocalBackend(dir, OWNER, REPO, STATE_KEY)
  return dir
}

describe("persistent state integration (local dev mode)", () => {
  const workDirs: string[] = []

  afterAll(async () => {
    // Clean up temp dirs
    for (const dir of workDirs) {
      await rm(dir, { recursive: true, force: true })
    }
    // Clean up persistent state
    await removeLocalState(OWNER, REPO, STATE_KEY)
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
    expect(stateExistsSync(OWNER, REPO, STATE_KEY)).toBe(true)

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
    await removeLocalState(OWNER, REPO, STATE_KEY)
    expect(stateExistsSync(OWNER, REPO, STATE_KEY)).toBe(false)

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
  test("returns clear error when TFC backend is not configured", async () => {
    const runner = new LocalRunner()

    // Run without TFC config - should fail with clear error
    const result = await runner.run({
      owner: "test-owner",
      repo: "test-repo",
      headSha: "abc123",
      command: "plan",
      workspacePath: "infra",
      stateKey: "test/terraform.tfstate",
      // Missing: tfcWorkspaceName, tfcOrganization, tfcToken
    })

    expect(result.success).toBe(false)
    expect(result.errorMessage).toContain("TFC backend configuration is required")
  })
})
