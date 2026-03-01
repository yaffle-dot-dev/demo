import type { RunType, TerraformResult } from "@yaffle/shared"

import type { Runner } from "./runner.ts"
import { runTerraform } from "./terraform.ts"
import { cleanupWorkspace, findTerraformDirs, prepareWorkspace } from "./workspace.ts"

/**
 * Local runner: clones the repo, finds TF directories,
 * and shells out to tofu/terraform as a subprocess.
 */
export class LocalRunner implements Runner {
  async run(opts: {
    owner: string
    repo: string
    headSha: string
    command: RunType
    variables?: Record<string, string>
    installationToken?: string
  }): Promise<TerraformResult> {
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
