/**
 * ECS Engine Spawner
 *
 * Spawns isolated runner tasks in ECS Fargate to execute tofu jobs.
 *
 * SECURITY: The runner executes untrusted user terraform code. It:
 *   - Has no access to Yaffle's database or secrets
 *   - Receives a scoped job token for API access (heartbeat, logs, state)
 *   - Runs in an isolated security group (no ingress)
 *   - Reaches the control plane via internal DNS (cp.internal.yaffle.dev)
 *
 * Flow (new API-based pattern):
 *   1. CP spawns ECS task with job ID, token, and API URL
 *   2. Runner claims job via API
 *   3. Runner fetches execution context (workspace URL, variables, etc.) via API
 *   4. Runner downloads workspace from S3 cache
 *   5. Runner executes tofu
 *   6. Runner streams logs and reports completion via API
 *
 * This is identical to local runner behavior - the only difference is
 * how the process is spawned (ECS task vs child process).
 */

import {
  ECSClient,
  RunTaskCommand,
  DescribeTasksCommand,
  type RunTaskCommandInput,
  type Tag,
} from "@aws-sdk/client-ecs"

import { buildOrgResourceTags } from "./aws-tags.ts"
import { getAwsClientConfig } from "./aws-client-config.ts"
import { logger } from "./telemetry.ts"
import type { IacEngineSpawner } from "./scheduler.ts"
import { getJobWithContext, updateJobEcsTask } from "../db/queries/iac-jobs.ts"
import { findScanJobById } from "../db/queries/scan-jobs.ts"

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
  /** AWS region */
  region: string
  /** Control plane API URL (accessible from ECS task) */
  apiUrl: string
}

interface RunEcsTaskOptions {
  environment: Array<{ name: string; value: string }>
  command?: string[]
  tags: Tag[]
}

interface OrgOwnedTaskTagOptions {
  orgId: string
  orgSlug?: string
  resourceClass: string
  extraTags: Record<string, string>
}

function buildEcsTaskTags(options: OrgOwnedTaskTagOptions): Tag[] {
  return buildOrgResourceTags(
    {
      orgId: options.orgId,
      orgSlug: options.orgSlug,
    },
    {
      resourceClass: options.resourceClass,
      extraTags: options.extraTags,
    },
  )
}

/**
 * Production engine spawner using ECS Fargate.
 *
 * Spawns an isolated ECS task that behaves identically to the local runner:
 * - Claims job via API
 * - Fetches context via API
 * - Downloads workspace from S3
 * - Executes terraform
 * - Streams logs and reports completion via API
 */
export class EcsEngineSpawner implements IacEngineSpawner {
  private readonly config: EcsSpawnerConfig
  private readonly ecs: ECSClient

  constructor(config: EcsSpawnerConfig) {
    this.config = config
    this.ecs = new ECSClient(getAwsClientConfig(config.region))
  }

  private async runTask(options: RunEcsTaskOptions): Promise<string> {
    const taskInput: RunTaskCommandInput = {
      cluster: this.config.clusterArn,
      taskDefinition: this.config.taskDefinition,
      launchType: "FARGATE",
      enableECSManagedTags: true,
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
            environment: options.environment,
            ...(options.command ? { command: options.command } : {}),
          },
        ],
      },
      tags: options.tags,
    }

    const result = await this.ecs.send(new RunTaskCommand(taskInput))

    if (!result.tasks || result.tasks.length === 0) {
      const failures = result.failures?.map((f) => f.reason).join(", ") ?? "Unknown error"
      throw new Error(`Failed to start ECS task: ${failures}`)
    }

    return result.tasks[0].taskArn!
  }

  private async buildRunnerTaskTags(jobId: string): Promise<Tag[]> {
    const job = await getJobWithContext(jobId)
    if (!job?.deployment) {
      throw new Error(`Cannot spawn ECS runner task: job ${jobId} missing deployment context`)
    }

    return buildEcsTaskTags({
      orgId: job.deployment.orgId,
      orgSlug: job.deployment.orgSlug,
      resourceClass: "runner-task",
      extraTags: {
        "yaffle:job-id": jobId,
      },
    })
  }

  private async buildScannerTaskTags(scanJobId: string): Promise<Tag[]> {
    const scanJob = await findScanJobById(scanJobId)
    if (!scanJob) {
      throw new Error(`Cannot spawn ECS scanner task: scan job ${scanJobId} not found`)
    }

    return buildEcsTaskTags({
      orgId: scanJob.orgId,
      orgSlug: scanJob.orgSlug,
      resourceClass: "scanner-task",
      extraTags: {
        "yaffle:scan-job-id": scanJobId,
      },
    })
  }

  /**
   * Spawn an ECS task to execute a job.
   *
   * This method only passes three environment variables:
   * - YAFFLE_JOB_ID
   * - YAFFLE_JOB_TOKEN
   * - YAFFLE_API_URL
   *
   * The worker fetches everything else it needs via the API.
   */
  async spawn(jobId: string, jobToken: string): Promise<void> {
    logger.info("Spawning ECS runner task", { jobId })

    // Build environment variables - same as local spawner
    const envVars = [
      { name: "YAFFLE_JOB_ID", value: jobId },
      { name: "YAFFLE_JOB_TOKEN", value: jobToken },
      { name: "YAFFLE_API_URL", value: this.config.apiUrl },
    ]

    const taskArn = await this.runTask({
      environment: envVars,
      tags: await this.buildRunnerTaskTags(jobId),
    })

    logger.info("ECS runner task started", {
      jobId,
      taskArn,
      cluster: this.config.clusterArn,
    })

    // Store taskArn in database for tracking
    await updateJobEcsTask(jobId, taskArn)
  }

  /**
   * Spawn a scanner worker as an ECS task.
   *
   * Uses the same task definition as runners but overrides the command
   * to run scanner.ts instead of worker.ts.
   */
  async spawnScanner(scanJobId: string, scanToken: string): Promise<void> {
    logger.info("Spawning ECS scanner task", { scanJobId })

    const envVars = [
      { name: "YAFFLE_SCAN_JOB_ID", value: scanJobId },
      { name: "YAFFLE_JOB_TOKEN", value: scanToken },
      { name: "YAFFLE_API_URL", value: this.config.apiUrl },
    ]

    const taskArn = await this.runTask({
      environment: envVars,
      command: ["bun", "run", "/app/apps/runner/src/scanner.ts"],
      tags: await this.buildScannerTaskTags(scanJobId),
    })

    logger.info("ECS scanner task started", {
      scanJobId,
      taskArn,
      cluster: this.config.clusterArn,
    })
  }

  async spawnWarmRunner(input: {
    orgId: string
    orgSlug?: string
    runnerToken: string
    maxSlots: number
  }): Promise<string> {
    logger.info("Spawning ECS warm runner task", {
      orgId: input.orgId,
      orgSlug: input.orgSlug,
      maxSlots: input.maxSlots,
    })

    const envVars = [
      { name: "YAFFLE_WARM_RUNNER_TOKEN", value: input.runnerToken },
      { name: "YAFFLE_WARM_RUNNER_MAX_SLOTS", value: String(input.maxSlots) },
      { name: "YAFFLE_API_URL", value: this.config.apiUrl },
    ]

    const taskArn = await this.runTask({
      environment: envVars,
      command: ["bun", "run", "/app/apps/runner/src/warm-runner.ts"],
      tags: [
        ...buildOrgResourceTags(
          {
            orgId: input.orgId,
            orgSlug: input.orgSlug,
          },
          {
            resourceClass: "warm-runner-task",
            extraTags: {
              "yaffle:warm-runner": "true",
              "yaffle:warm-runner-max-slots": String(input.maxSlots),
            },
          },
        ),
      ],
    })

    logger.info("ECS warm runner task started", {
      orgId: input.orgId,
      orgSlug: input.orgSlug,
      maxSlots: input.maxSlots,
      taskArn,
      cluster: this.config.clusterArn,
    })

    return taskArn
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

/**
 * Create an ECS spawner from environment configuration.
 */
export function createEcsSpawner(): EcsEngineSpawner {
  const clusterArn = process.env.YAFFLE_ECS_CLUSTER_ARN ?? process.env.YAFFLE_ECS_CLUSTER
  const taskDefinition = process.env.YAFFLE_RUNNER_TASK_DEFINITION ?? process.env.YAFFLE_ECS_TASK_DEFINITION
  const subnets = (process.env.YAFFLE_RUNNER_SUBNETS ?? process.env.YAFFLE_ECS_SUBNETS ?? "")
    .split(",")
    .filter(Boolean)
  const securityGroups = (process.env.YAFFLE_RUNNER_SECURITY_GROUPS ?? process.env.YAFFLE_ECS_SECURITY_GROUPS ?? "")
    .split(",")
    .filter(Boolean)
  const region = process.env.AWS_REGION ?? "us-east-1"
  const apiUrl = process.env.YAFFLE_RUNNER_API_URL

  if (!clusterArn) {
    throw new Error("YAFFLE_ECS_CLUSTER_ARN or YAFFLE_ECS_CLUSTER not configured")
  }
  if (!taskDefinition) {
    throw new Error("YAFFLE_RUNNER_TASK_DEFINITION or YAFFLE_ECS_TASK_DEFINITION not configured")
  }
  if (subnets.length === 0) {
    throw new Error("YAFFLE_RUNNER_SUBNETS or YAFFLE_ECS_SUBNETS not configured")
  }
  if (securityGroups.length === 0) {
    throw new Error("YAFFLE_RUNNER_SECURITY_GROUPS or YAFFLE_ECS_SECURITY_GROUPS not configured")
  }
  if (!apiUrl) {
    throw new Error("YAFFLE_RUNNER_API_URL not configured")
  }

  return new EcsEngineSpawner({
    clusterArn,
    taskDefinition,
    subnets,
    securityGroups,
    region,
    apiUrl,
  })
}
