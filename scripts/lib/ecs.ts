/**
 * ECS task definition and service deployment helpers.
 *
 * Uses @aws-sdk/client-ecs (available in the workspace via control-plane deps).
 */

import {
  ECSClient,
  DescribeTaskDefinitionCommand,
  RegisterTaskDefinitionCommand,
  UpdateServiceCommand,
  DescribeServicesCommand,
  waitUntilServicesStable,
} from "@aws-sdk/client-ecs"

let _client: ECSClient | null = null

interface AwsLikeError {
  name?: string
  message?: string
  __type?: string
  $metadata?: {
    httpStatusCode?: number
    requestId?: string
  }
}

function client(): ECSClient {
  if (!_client) {
    _client = new ECSClient({ region: process.env.AWS_REGION ?? "us-east-1" })
  }
  return _client
}

function formatAwsError(prefix: string, error: unknown): Error {
  if (error instanceof Error) {
    const awsError = error as AwsLikeError
    const parts = [prefix]

    if (awsError.name && awsError.name !== "Error") {
      parts.push(awsError.name)
    } else if (awsError.__type) {
      parts.push(awsError.__type)
    }

    if (awsError.message) {
      parts.push(awsError.message)
    }

    if (awsError.$metadata?.httpStatusCode || awsError.$metadata?.requestId) {
      parts.push(
        `status=${awsError.$metadata?.httpStatusCode ?? "unknown"} requestId=${awsError.$metadata?.requestId ?? "unknown"}`,
      )
    }

    return new Error(parts.join(": "))
  }

  return new Error(`${prefix}: ${String(error)}`)
}

async function assertServiceExists(cluster: string, service: string): Promise<void> {
  try {
    const result = await client().send(
      new DescribeServicesCommand({
        cluster,
        services: [service],
      }),
    )

    if (result.failures && result.failures.length > 0) {
      const failure = result.failures[0]
      throw new Error(
        `ECS service ${service} not found in cluster ${cluster} (reason=${failure.reason ?? "unknown"})`,
      )
    }

    if (!result.services || result.services.length === 0) {
      throw new Error(`ECS service ${service} not found in cluster ${cluster}`)
    }
  } catch (error) {
    throw formatAwsError(`Failed to describe ECS service ${service}`, error)
  }
}

// Fields that must be stripped from a described task def before re-registering
const IMMUTABLE_FIELDS = [
  "taskDefinitionArn",
  "revision",
  "status",
  "requiresAttributes",
  "compatibilities",
  "registeredAt",
  "registeredBy",
] as const

/**
 * Fetch the current active task definition for a family, stripped of immutable fields.
 */
export async function describeTaskDefinition(family: string): Promise<Record<string, any>> {
  const result = await client().send(
    new DescribeTaskDefinitionCommand({ taskDefinition: family })
  ).catch((error) => {
    throw formatAwsError(`Failed to describe task definition ${family}`, error)
  })

  const taskDef = result.taskDefinition as Record<string, any>
  if (!taskDef) {
    throw new Error(`Task definition not found: ${family}`)
  }

  for (const field of IMMUTABLE_FIELDS) {
    delete taskDef[field]
  }

  return taskDef
}

/**
 * Update the image for a named container in a task definition.
 * Returns a new object (does not mutate).
 */
export function renderImage(
  taskDef: Record<string, any>,
  containerName: string,
  image: string,
): Record<string, any> {
  const containers = taskDef.containerDefinitions as Array<Record<string, any>>
  const target = containers?.find((c) => c.name === containerName)

  if (!target) {
    const names = containers?.map((c) => c.name).join(", ") ?? "none"
    throw new Error(`Container '${containerName}' not found in task def (has: ${names})`)
  }

  return {
    ...taskDef,
    containerDefinitions: containers.map((c) =>
      c.name === containerName ? { ...c, image } : c
    ),
  }
}

/**
 * Register a new task definition revision. Returns the full ARN.
 */
export async function registerTaskDefinition(taskDef: Record<string, any>): Promise<string> {
  const family = typeof taskDef.family === "string" ? taskDef.family : "unknown"
  const result = await client().send(
    new RegisterTaskDefinitionCommand(taskDef as any)
  ).catch((error) => {
    throw formatAwsError(`Failed to register task definition for family ${family}`, error)
  })

  const arn = result.taskDefinition?.taskDefinitionArn
  if (!arn) {
    throw new Error("Failed to register task definition — no ARN returned")
  }

  console.log(`Registered task definition: ${arn}`)
  return arn
}

/**
 * Update an ECS service to use a new task definition.
 */
export async function deployService(
  cluster: string,
  service: string,
  taskDefinitionArn: string,
): Promise<void> {
  await assertServiceExists(cluster, service)

  await client().send(
    new UpdateServiceCommand({
      cluster,
      service,
      taskDefinition: taskDefinitionArn,
    })
  ).catch((error) => {
    throw formatAwsError(
      `Failed to update ECS service ${service} in cluster ${cluster}`,
      error,
    )
  })
  console.log(`Updated service ${service} to ${taskDefinitionArn}`)
}

/**
 * Wait for an ECS service to reach stable state.
 */
export async function waitForStability(
  cluster: string,
  service: string,
  maxWaitSeconds = 300,
): Promise<void> {
  console.log(`Waiting for service ${service} to stabilize...`)

  await assertServiceExists(cluster, service)

  await waitUntilServicesStable(
    { client: client(), maxWaitTime: maxWaitSeconds },
    { cluster, services: [service] },
  ).catch((error) => {
    throw formatAwsError(
      `ECS service ${service} in cluster ${cluster} did not stabilize`,
      error,
    )
  })

  console.log(`Service ${service} is stable`)
}
