import { existsSync } from "node:fs"

import type { TerraformResult } from "@yaffle/shared"

import type { RunOpts, Runner } from "./runner.ts"
import { configureBackend, configureProviderOverride } from "./state.ts"
import { configureTfcBackend, buildTfcEnvVars, useTfcBackend } from "./tfc-backend.ts"
import { getTfcApiHost } from "./run-token.ts"
import { forceUnlockWorkspace } from "../db/queries/workspaces.ts"
import { logger, withSpan } from "./telemetry.ts"
import { runTerraform } from "./terraform.ts"
import { cleanupWorkspace, prepareWorkspace } from "./workspace.ts"

/**
 * Local runner: clones the repo, configures a persistent local backend
 * for the specified workspace path, and shells out to tofu/terraform.
 *
 * Supports two backend modes:
 * 1. S3/Local backend (default): Direct S3 state storage with DynamoDB locking
 * 2. TFC backend: Uses Yaffle's TFC-compatible API for state management
 */
export class LocalRunner implements Runner {
  async run(opts: RunOpts): Promise<TerraformResult> {
    return withSpan("local_runner.run", async (span) => {
      const backendMode = useTfcBackend() && opts.tfcWorkspaceName ? "tfc" : "s3"

      span.setAttributes({
        "runner.type": "local",
        "runner.command": opts.command,
        "runner.workspace_path": opts.workspacePath,
        "runner.state_key": opts.stateKey,
        "runner.backend_mode": backendMode,
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

        // Verify the workspace path actually exists in the repo
        if (!existsSync(tfDir)) {
          const shortSha = opts.headSha.slice(0, 7)
          return {
            success: false,
            command: opts.command,
            output: "",
            errorMessage:
              `Workspace path "${opts.workspacePath}" not found in ${opts.owner}/${opts.repo} at ${shortSha}. ` +
              "Check that the path in .yaffle/config.yml matches a directory in your repository.",
            durationMs: 0,
          }
        }

        // Configure backend based on mode
        let extraEnv: Record<string, string> = {}

        if (backendMode === "tfc" && opts.tfcWorkspaceName && opts.tfcOrganization && opts.tfcToken) {
          // TFC backend mode: Use Yaffle's TFC-compatible API
          const tfcHost = getTfcApiHost()
          await configureTfcBackend(tfDir, {
            hostname: tfcHost,
            organization: opts.tfcOrganization,
            workspaceName: opts.tfcWorkspaceName,
            token: opts.tfcToken,
          })
          extraEnv = buildTfcEnvVars(opts.tfcToken)
          
          logger.info("TFC backend configured", {
            hostname: tfcHost,
            organization: opts.tfcOrganization,
            workspaceName: opts.tfcWorkspaceName,
            tokenEnvVar: `TF_TOKEN_${tfcHost.replace(/[.:]/g, "_")}`,
            tokenPrefix: opts.tfcToken.slice(0, 20) + "...",
          })
        } else {
          // Legacy S3/local backend mode
          await configureBackend(tfDir, opts.owner, opts.repo, opts.stateKey)
        }

        // Inject Yaffle tags into AWS provider default_tags
        await configureProviderOverride(tfDir, {
          workspacePath: opts.workspacePath,
          runId: opts.runId,
          prNumber: opts.prNumber,
        })

        return await runTerraform({
          workDir: tfDir,
          command: opts.command,
          variables: opts.variables,
          onOutput: opts.onOutput,
          extraEnv,
        })
      } finally {
        // Always unlock TFC workspace when terraform exits (success, failure, or crash)
        // This prevents orphaned locks when terraform doesn't send the unlock request
        if (backendMode === "tfc" && opts.tfcWorkspaceId) {
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
