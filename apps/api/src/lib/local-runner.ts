import type { TerraformResult } from "@yaffle/shared"

import type { RunOpts, Runner } from "./runner.ts"
import { configureLocalBackend } from "./state.ts"
import { runTerraform } from "./terraform.ts"
import { cleanupWorkspace, findTerraformDirs, prepareWorkspace } from "./workspace.ts"

/**
 * Local runner: clones the repo, finds TF directories, configures
 * a persistent local backend, and shells out to tofu/terraform.
 */
export class LocalRunner implements Runner {
  async run(opts: RunOpts): Promise<TerraformResult> {
    const start = Date.now()
    let workDir: string | undefined

    try {
      workDir = await prepareWorkspace({
        owner: opts.owner,
        repo: opts.repo,
        headSha: opts.headSha,
        installationToken: opts.installationToken,
      })
      console.log(`workspace prepared: ${workDir}`)

      const tfDirs = await findTerraformDirs(workDir)
      if (tfDirs.length === 0) {
        return {
          success: true,
          command: opts.command,
          output: "No terraform files found in this repository.",
          planSummary: "no changes",
          durationMs: Date.now() - start,
        }
      }

      console.log(`found terraform in: ${tfDirs.join(", ")}`)

      // Run against the first TF directory found
      // TODO: support multiple TF directories from .yaffle/config.yml
      const tfDir = tfDirs[0] === "." ? workDir : `${workDir}/${tfDirs[0]}`

      // Configure persistent local backend before init
      await configureLocalBackend(tfDir, opts.owner, opts.repo, opts.stateKey)

      return await runTerraform({
        workDir: tfDir,
        command: opts.command,
        variables: opts.variables,
      })
    } finally {
      if (workDir) {
        await cleanupWorkspace(workDir)
      }
    }
  }
}
