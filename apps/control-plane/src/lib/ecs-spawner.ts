/**
 * ECS Engine Spawner
 *
 * Spawns isolated runner tasks in ECS Fargate to execute tofu jobs.
 *
 * SECURITY: The runner executes untrusted user terraform code. It:
 *   - Has no access to Yaffle's database or secrets
 *   - Receives all inputs via presigned S3 URLs (short-lived)
 *   - Runs in an isolated security group
 *   - Cannot reach internal services
 *
 * Flow:
 *   1. CP prepares workspace tarball with all config
 *   2. CP uploads to S3 and generates presigned URLs
 *   3. CP spawns ECS task with presigned URLs as env vars
 *   4. Runner downloads workspace, runs tofu, uploads results
 *   5. CP polls CloudWatch/S3 for completion
 *   6. CP fetches results and updates database
 */

import {
  ECSClient,
  RunTaskCommand,
  DescribeTasksCommand,
  type RunTaskCommandInput,
} from "@aws-sdk/client-ecs"

import { logger } from "./telemetry.ts"
import type { IacEngineSpawner } from "./scheduler.ts"
import { getJobWithContext, updateJobEcsTask } from "../db/queries/iac-jobs.ts"
import { findOrgById } from "../db/queries/organizations.ts"
import { getInstallationToken, fetchFileContent } from "./github.ts"
import {
  prepareWorkspace,
  cleanupWorkspace,
  WorkspacePackager,
} from "./workspace.ts"
import { parseYaffleToml, buildPrEnvironmentName, type Workspace } from "./config-toml.ts"
import { renderVariables, TemplateError, type TemplateContext } from "./templating.ts"
import { useTfcBackend } from "./tfc-backend.ts"
import { ensurePreviewWorkspace, ensureNamedWorkspace } from "./workspace-service.ts"
import { generateRunToken } from "./run-token.ts"
import { getTfcApiHost } from "./run-token.ts"

/**
 * Configuration for the ECS runner spawner.
 */
export interface EcsSpawnerConfig {
  /** ECS cluster ARN */
  clusterArn: string
  /** Runner task definition ARN or family:revision */
  taskDefinition: string
  /** Subnet IDs for task networking */
  subnets: string[]
  /** Security group IDs for task networking */
  securityGroups: string[]
  /** S3 bucket for workspaces and results */
  workspacesBucket: string
  /** AWS region */
  region: string
}

/**
 * Context passed to the runner via presigned URLs.
 * This is uploaded to S3 and downloaded by the runner.
 */
export interface RunnerContext {
  jobId: string
  command: "plan" | "apply" | "destroy"
  variables: Record<string, string | boolean | number>
  backendConfig: {
    hostname: string
    organization: string
    workspaceName: string
  }
}

/**
 * Production engine spawner using ECS Fargate.
 *
 * Instead of running tofu in-process like LocalEngineSpawner,
 * this spawns an isolated ECS task that:
 *   - Downloads the workspace from S3
 *   - Runs tofu
 *   - Uploads results to S3
 *
 * The CP then polls for completion and fetches results.
 */
export class EcsEngineSpawner implements IacEngineSpawner {
  private readonly config: EcsSpawnerConfig
  private readonly ecs: ECSClient
  private readonly packager: WorkspacePackager

  constructor(config: EcsSpawnerConfig) {
    this.config = config
    this.ecs = new ECSClient({ region: config.region })
    this.packager = new WorkspacePackager({
      bucket: config.workspacesBucket,
      region: config.region,
    })
  }

  /**
   * Spawn an ECS task to execute a job.
   *
   * This method:
   *   1. Fetches job context from database
   *   2. Clones repo and prepares workspace
   *   3. Packages workspace and uploads to S3
   *   4. Generates presigned URLs for runner
   *   5. Spawns ECS task with URLs as environment variables
   *
   * The task runs asynchronously - this method returns immediately.
   * The scheduler handles completion polling.
   */
  async spawn(jobId: string): Promise<void> {
    logger.info("Spawning ECS runner task", { jobId })

    // Fetch job context
    const jobContext = await getJobWithContext(jobId)
    if (!jobContext) {
      throw new Error(`Job not found: ${jobId}`)
    }

    const { deployment, ...job } = jobContext

    // Get organization
    const org = await findOrgById(deployment.orgId)
    if (!org) {
      throw new Error(`Organization not found: ${deployment.orgId}`)
    }

    // Parse owner/repo
    const repoParts = deployment.repo.split("/")
    const owner = repoParts.length > 1 ? repoParts[0] : org.slug
    const repo = repoParts.length > 1 ? repoParts[1] : deployment.repo

    // Determine environment kind and name
    const isPr = deployment.prNumber != null && deployment.prNumber > 0
    const environmentKind = isPr ? "transient" : "named"
    const environmentName = isPr
      ? buildPrEnvironmentName(deployment.prNumber!)
      : deployment.environmentName

    // Get installation token for repo access
    let installationToken: string | undefined
    if (deployment.installationId) {
      installationToken = await getInstallationToken(deployment.installationId)
    }

    // Fetch config to get workspace-specific variables
    let workspace: Workspace | undefined
    if (deployment.installationId) {
      try {
        const configRaw = await fetchFileContent(
          deployment.installationId,
          owner,
          repo,
          "yaffle.toml",
          deployment.headSha,
        )
        if (configRaw) {
          const config = parseYaffleToml(configRaw)
          workspace = config.workspaces.find((ws) => ws.path === deployment.workspacePath)
        }
      } catch (err) {
        logger.warn("Failed to load config for variables", {
          jobId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Build variables - always inject environment and environment_kind
    const variables: Record<string, string | boolean | number> = {
      environment: environmentName,
      environment_kind: environmentKind,
    }
    if (workspace?.variables) {
      const refName = deployment.ref.replace(/^refs\/(heads|tags)\//, "")
      const templateContext: TemplateContext = {
        environment: environmentName,
        environment_kind: environmentKind,
        org: owner,
        repo,
        workspace_path: deployment.workspacePath,
        branch: refName,
        commit_sha: deployment.headSha,
        pr_number: isPr ? deployment.prNumber! : null,
      }

      try {
        const renderedVars = renderVariables(
          workspace.variables,
          templateContext,
          deployment.workspacePath,
        )
        for (const [key, value] of Object.entries(renderedVars)) {
          variables[key] = value
        }
      } catch (err) {
        if (err instanceof TemplateError) {
          throw new Error(`Variable template error: ${err.message}`)
        }
        throw err
      }
    }

    // Build backend config
    let backendConfig: RunnerContext["backendConfig"] | undefined
    let tfcToken: string | undefined
    if (useTfcBackend()) {
      const tfcWorkspace = isPr
        ? await ensurePreviewWorkspace({
            orgId: org.id,
            orgSlug: org.slug,
            repo: deployment.repo,
            environment: environmentName,
            prNumber: deployment.prNumber!,
            workspacePath: deployment.workspacePath,
            ref: deployment.ref,
          })
        : await ensureNamedWorkspace({
            orgId: org.id,
            orgSlug: org.slug,
            repo: deployment.repo,
            environment: environmentName,
            ref: deployment.ref,
            workspacePath: deployment.workspacePath,
          })

      backendConfig = {
        hostname: getTfcApiHost(),
        organization: org.slug,
        workspaceName: tfcWorkspace.name,
      }
      tfcToken = await generateRunToken(deployment.id, tfcWorkspace.id, org.id)
    }

    // Clone the repository
    let workDir: string | undefined
    try {
      workDir = await prepareWorkspace({
        owner,
        repo,
        headSha: deployment.headSha,
        installationToken,
      })

      // Package workspace and upload to S3
      const prepared = await this.packager.packageAndUpload(
        workDir,
        jobId,
        deployment.workspacePath,
      )

      // Build environment variables for the runner
      const envVars = [
        { name: "JOB_ID", value: jobId },
        { name: "WORKSPACE_URL", value: prepared.workspaceUrl },
        { name: "RESULTS_URL", value: prepared.resultsUrl },
        { name: "LOGS_URL", value: prepared.logsUrl },
        { name: "COMMAND", value: job.jobType },
        { name: "VARS_JSON", value: JSON.stringify(variables) },
      ]

      // Add backend config if using TFC backend
      if (backendConfig) {
        envVars.push({ name: "BACKEND_CONFIG", value: JSON.stringify(backendConfig) })
      }
      if (tfcToken) {
        envVars.push({ name: "TFC_TOKEN", value: tfcToken })
      }

      // Build task input
      const taskInput: RunTaskCommandInput = {
        cluster: this.config.clusterArn,
        taskDefinition: this.config.taskDefinition,
        launchType: "FARGATE",
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: this.config.subnets,
            securityGroups: this.config.securityGroups,
            assignPublicIp: "DISABLED",
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: "runner",
              environment: envVars,
            },
          ],
        },
        // Tag the task for tracking
        tags: [
          { key: "yaffle:job-id", value: jobId },
          { key: "yaffle:org-id", value: deployment.orgId },
        ],
      }

      // Run the task
      const result = await this.ecs.send(new RunTaskCommand(taskInput))

      if (!result.tasks || result.tasks.length === 0) {
        const failures = result.failures?.map((f) => f.reason).join(", ") ?? "Unknown error"
        throw new Error(`Failed to start ECS task: ${failures}`)
      }

      const taskArn = result.tasks[0].taskArn!
      logger.info("ECS runner task started", {
        jobId,
        taskArn,
        cluster: this.config.clusterArn,
        hasBackendConfig: !!backendConfig,
        variableCount: Object.keys(variables).length,
      })

      // Store taskArn in database for tracking
      await updateJobEcsTask(jobId, taskArn)
    } finally {
      // Clean up local workspace
      if (workDir) {
        await cleanupWorkspace(workDir)
      }
    }
  }

  /**
   * Get the status of a running task.
   */
  async getTaskStatus(taskArn: string): Promise<"PENDING" | "RUNNING" | "STOPPED" | "UNKNOWN"> {
    const result = await this.ecs.send(
      new DescribeTasksCommand({
        cluster: this.config.clusterArn,
        tasks: [taskArn],
      }),
    )

    if (!result.tasks || result.tasks.length === 0) {
      return "UNKNOWN"
    }

    const status = result.tasks[0].lastStatus
    if (status === "PENDING" || status === "PROVISIONING" || status === "ACTIVATING") {
      return "PENDING"
    }
    if (status === "RUNNING") {
      return "RUNNING"
    }
    if (status === "DEACTIVATING" || status === "STOPPING" || status === "DEPROVISIONING" || status === "STOPPED") {
      return "STOPPED"
    }

    return "UNKNOWN"
  }
}
