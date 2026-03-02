import type { TerraformResult } from "@yaffle/shared"

import type { RunOpts, Runner } from "./runner.ts"
import { configureLocalBackend } from "./state.ts"
import { logger, withSpan } from "./telemetry.ts"
import { runTerraform } from "./terraform.ts"
import { cleanupWorkspace, prepareWorkspace } from "./workspace.ts"

/**
 * Local runner: clones the repo, configures a persistent local backend
 * for the specified workspace path, and shells out to tofu/terraform.
 */
export class LocalRunner implements Runner {
  async run(opts: RunOpts): Promise<TerraformResult> {
    return withSpan("local_runner.run", async (span) => {
      span.setAttributes({
        "runner.type": "local",
        "runner.command": opts.command,
        "runner.workspace_path": opts.workspacePath,
        "runner.state_key": opts.stateKey,
      })

      let workDir: string | undefined

      try {
        workDir = await prepareWorkspace({
          owner: opts.owner,
          repo: opts.repo,
          headSha: opts.headSha,
          installationToken: opts.installationToken,
        })
        logger.info(`workspace prepared: ${workDir}`, {
          "runner.work_dir": workDir,
        })

        const tfDir = opts.workspacePath === "."
          ? workDir
          : `${workDir}/${opts.workspacePath}`

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
    })
  }
}
