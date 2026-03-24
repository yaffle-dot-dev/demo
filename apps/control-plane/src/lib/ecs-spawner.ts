/**
 * ECS Engine Spawner
 *
 * Spawns isolated runner tasks in ECS Fargate to execute tofu jobs.
 *
 * SECURITY: The runner executes untrusted user terraform code. It:
 *   - Has no access to Yaffle's database or secrets
 *   - Receives job token for scoped API access
 *   - Runs in an isolated security group
 *   - Cannot reach internal services
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
} from "@aws-sdk/client-ecs"

import { getAwsClientConfig } from "./aws-client-config.ts"
import { logger } from "./telemetry.ts"
import type { IacEngineSpawner } from "./scheduler.ts"
import { updateJobEcsTask } from "../db/queries/iac-jobs.ts"

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
    })

    // Store taskArn in database for tracking
    await updateJobEcsTask(jobId, taskArn)
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
  const clusterArn = process.env.YAFFLE_ECS_CLUSTER_ARN
  const taskDefinition = process.env.YAFFLE_RUNNER_TASK_DEFINITION
  const subnets = process.env.YAFFLE_RUNNER_SUBNETS?.split(",") ?? []
  const securityGroups = process.env.YAFFLE_RUNNER_SECURITY_GROUPS?.split(",") ?? []
  const region = process.env.AWS_REGION ?? "us-east-1"
  const apiUrl = process.env.YAFFLE_RUNNER_API_URL ?? process.env.YAFFLE_API_URL

  if (!clusterArn) {
    throw new Error("YAFFLE_ECS_CLUSTER_ARN not configured")
  }
  if (!taskDefinition) {
    throw new Error("YAFFLE_RUNNER_TASK_DEFINITION not configured")
  }
  if (subnets.length === 0) {
    throw new Error("YAFFLE_RUNNER_SUBNETS not configured")
  }
  if (securityGroups.length === 0) {
    throw new Error("YAFFLE_RUNNER_SECURITY_GROUPS not configured")
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
