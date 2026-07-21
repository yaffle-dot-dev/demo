import { existsSync } from "node:fs"

import type { TerraformResult } from "@yaffle/shared"

import type { RunOpts, Runner } from "./runner.ts"
import { configureProviderOverride, configureVariablesOverride } from "./state.ts"
import { configureTfcBackend, buildTfcEnvVars, writeEphemeralCredentials } from "./tfc-backend.ts"
import { getTfcApiHost } from "./run-token.ts"
import { forceUnlockWorkspace } from "../db/queries/workspaces.ts"
import { logger, withSpan } from "./telemetry.ts"
import { runTerraform } from "./terraform.ts"
import { cleanupWorkspace, prepareWorkspace } from "./workspace.ts"

/**
 * Local runner: clones the repo, configures the TFC backend,
 * and shells out to tofu/terraform.
 *
 * Uses Yaffle's TFC-compatible API for state management with Postgres locking.
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

      // TFC backend is required
      if (!opts.tfcWorkspaceName || !opts.tfcOrganization || !opts.tfcToken) {
        return {
          success: false,
          command: opts.command,
          output: "",
          errorMessage:
            "TFC backend configuration is required. " +
            "Ensure YAFFLE_TFC_API_HOST is set and workspace is properly configured.",
          durationMs: 0,
        }
      }

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

        const tfDir = opts.workspacePath === "." ? workDir : `${workDir}/${opts.workspacePath}`

        // Verify the workspace path actually exists in the repo
        if (!existsSync(tfDir)) {
          const shortSha = opts.headSha.slice(0, 7)
          return {
            success: false,
            command: opts.command,
            output: "",
            errorMessage:
              `Workspace path "${opts.workspacePath}" not found in ${opts.owner}/${opts.repo} at ${shortSha}. ` +
              "Check that the path in yaffle.toml matches a directory in your repository.",
            durationMs: 0,
          }
        }

        // Configure TFC backend
        const tfcHost = getTfcApiHost()

        await configureTfcBackend(tfDir, {
          hostname: tfcHost,
          organization: opts.tfcOrganization,
          workspaceName: opts.tfcWorkspaceName,
          token: opts.tfcToken,
        })

        // Write ephemeral credentials for module registry auth
        // TF_TOKEN_* env vars only work for cloud backend, not module registry
        const credentialsPath = await writeEphemeralCredentials(tfDir, opts.tfcToken)
        const extraEnv = buildTfcEnvVars(opts.tfcToken, credentialsPath)

        logger.info("TFC backend configured", {
          hostname: tfcHost,
          organization: opts.tfcOrganization,
          workspaceName: opts.tfcWorkspaceName,
          tokenEnvVar: `TF_TOKEN_${tfcHost.replace(/[.:]/g, "_")}`,
          tokenPrefix: opts.tfcToken.slice(0, 20) + "...",
          credentialsPath,
        })

        // Inject Yaffle tags into AWS provider default_tags
        await configureProviderOverride(tfDir, {
          workspacePath: opts.workspacePath,
          prNumber: opts.prNumber,
        })

        // Inject Yaffle variables (environment, environment_kind) if not declared
        await configureVariablesOverride(tfDir)

        return await runTerraform({
          workDir: tfDir,
          command: opts.command,
          variables: opts.variables,
          onOutput: opts.onOutput,
          extraEnv,
          runId: opts.runId,
        })
      } finally {
        // Always unlock TFC workspace when terraform exits (success, failure, or crash)
        // This prevents orphaned locks when terraform doesn't send the unlock request
        if (opts.tfcWorkspaceId) {
          try {
            const unlocked = await forceUnlockWorkspace(opts.tfcWorkspaceId)
            if (unlocked) {
              logger.info("Force unlocked TFC workspace on runner exit", {
                workspaceId: opts.tfcWorkspaceId,
                workspaceName: opts.tfcWorkspaceName,
              })
            }
          } catch (err) {
            logger.warn("Failed to force unlock TFC workspace on runner exit", {
              workspaceId: opts.tfcWorkspaceId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }

        if (workDir) {
          await cleanupWorkspace(workDir)
        }
      }
    })
  }
}
