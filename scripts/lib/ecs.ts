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

function client(): ECSClient {
  if (!_client) {
    _client = new ECSClient({ region: process.env.AWS_REGION ?? "us-east-1" })
  }
  return _client
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
  )

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
  const result = await client().send(
    new RegisterTaskDefinitionCommand(taskDef as any)
  )

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
  await client().send(
    new UpdateServiceCommand({
      cluster,
      service,
      taskDefinition: taskDefinitionArn,
    })
  )
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

  await waitUntilServicesStable(
    { client: client(), maxWaitTime: maxWaitSeconds },
    { cluster, services: [service] },
  )

  console.log(`Service ${service} is stable`)
}
