import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"

const mockSend = mock(async (_command: unknown) => ({
  tasks: [{ taskArn: "arn:aws:ecs:us-east-1:123456789012:task/cluster/task-123" }],
}))
const mockGetJobWithContext = mock(async (_jobId: string) => undefined as any)
const mockUpdateJobEcsTask = mock(async (_jobId: string, _taskArn: string) => {})
const mockFindScanJobById = mock(async (_scanJobId: string) => undefined as any)

class MockRunTaskCommand {
  constructor(readonly input: unknown) {}
}

class MockDescribeTasksCommand {
  constructor(readonly input: unknown) {}
}

class MockECSClient {
  send = mockSend

  constructor(_config: unknown) {}
}

mock.module("@aws-sdk/client-ecs", () => ({
  ECSClient: MockECSClient,
  RunTaskCommand: MockRunTaskCommand,
  DescribeTasksCommand: MockDescribeTasksCommand,
}))

mock.module("./aws-client-config.ts", () => ({
  getAwsClientConfig: (region: string) => ({ region }),
}))

mock.module("./telemetry.ts", () => ({
  logger: {
    info: () => {},
    error: () => {},
    warn: () => {},
  },
}))

mock.module("../db/queries/iac-jobs.ts", () => ({
  getJobWithContext: mockGetJobWithContext,
  updateJobEcsTask: mockUpdateJobEcsTask,
}))

mock.module("../db/queries/scan-jobs.ts", () => ({
  findScanJobById: mockFindScanJobById,
}))

let EcsEngineSpawner: typeof import("./ecs-spawner.ts").EcsEngineSpawner

beforeAll(async () => {
  ;({ EcsEngineSpawner } = await import("./ecs-spawner.ts"))
})

beforeEach(() => {
  mockSend.mockReset()
  mockSend.mockImplementation(async (_command: unknown) => ({
    tasks: [{ taskArn: "arn:aws:ecs:us-east-1:123456789012:task/cluster/task-123" }],
  }))

  mockGetJobWithContext.mockReset()
  mockGetJobWithContext.mockImplementation(async (_jobId: string) => ({
    id: "job-123",
    deploymentId: "deployment-123",
    jobType: "plan",
    status: "queued",
    workerId: null,
    lastHeartbeat: null,
    spawnLeaseToken: null,
    spawnLeaseHolder: null,
    spawnLeaseExpiresAt: null,
    queuedAt: new Date("2026-04-06T12:00:00Z"),
    dispatchedAt: null,
    lastSpawnAttemptAt: null,
    startedAt: null,
    blockedAt: null,
    completedAt: null,
    result: null,
    blockedReason: null,
    errorMessage: null,
    attempts: 0,
    spawnAttempts: 0,
    maxAttempts: 3,
    deployment: {
      id: "deployment-123",
      orgId: "org-123",
      orgSlug: "acme",
      repo: "acme/repo",
      environmentKind: "preview",
      environmentName: "pr-42",
      prNumber: 42,
      workspacePath: "apps/control-plane/infra",
      ref: "refs/heads/feature/test",
      headSha: "abcdef123456",
      stateKey: "previews/pr-42/terraform.tfstate",
      installationId: 123,
      runGroupId: "run-group-123",
    },
    preview: {
      id: "deployment-123",
      orgId: "org-123",
      orgSlug: "acme",
      repo: "acme/repo",
      prNumber: 42,
      workspacePath: "apps/control-plane/infra",
      ref: "refs/heads/feature/test",
      headSha: "abcdef123456",
      stateKey: "previews/pr-42/terraform.tfstate",
      installationId: 123,
      runGroupId: "run-group-123",
    },
  }))

  mockUpdateJobEcsTask.mockReset()
  mockUpdateJobEcsTask.mockImplementation(async (_jobId: string, _taskArn: string) => {})

  mockFindScanJobById.mockReset()
  mockFindScanJobById.mockImplementation(async (_scanJobId: string) => ({
    id: "scan-job-123",
    runGroupId: "run-group-123",
    orgId: "org-456",
    status: "queued",
    workerId: null,
    lastHeartbeat: null,
    repoUrl: "https://github.com/acme/repo.git",
    ref: "refs/heads/main",
    headSha: "abcdef123456",
    installationToken: null,
    orgSlug: "globex",
    workspacePaths: ["apps/web/infra"],
    result: null,
    errorMessage: null,
    queuedAt: new Date("2026-04-06T12:00:00Z"),
    startedAt: null,
    completedAt: null,
  }))
})

function createSpawner(): InstanceType<typeof EcsEngineSpawner> {
  return new EcsEngineSpawner({
    clusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/yaffle",
    taskDefinition: "yaffle-runner:1",
    subnets: ["subnet-123"],
    securityGroups: ["sg-123"],
    region: "us-east-1",
    apiUrl: "https://cp.internal.yaffle.dev",
  })
}

function getLastRunTaskInput(): Record<string, unknown> {
  const command = mockSend.mock.calls.at(-1)?.[0] as MockRunTaskCommand | undefined
  return (command?.input ?? {}) as Record<string, unknown>
}

function getTagMap(input: Record<string, unknown>): Record<string, string> {
  const tags = (input.tags ?? []) as Array<{ key: string; value: string }>
  return Object.fromEntries(tags.map((tag) => [tag.key, tag.value]))
}

describe("EcsEngineSpawner cost attribution tags", () => {
  test("tags runner tasks with org metadata", async () => {
    const spawner = createSpawner()

    await spawner.spawn("job-123", "job-token-123")

    const input = getLastRunTaskInput()
    expect(getTagMap(input)).toEqual({
      project: "yaffle",
      managed_by: "yaffle",
      "yaffle:org-id": "org-123",
      "yaffle:org-slug": "acme",
      "yaffle:resource-class": "runner-task",
      "yaffle:job-id": "job-123",
    })
    expect(input.enableECSManagedTags).toBe(true)
    expect(mockUpdateJobEcsTask).toHaveBeenCalledWith(
      "job-123",
      "arn:aws:ecs:us-east-1:123456789012:task/cluster/task-123",
    )
  })

  test("tags scanner tasks with org metadata", async () => {
    const spawner = createSpawner()

    await spawner.spawnScanner("scan-job-123", "scan-token-123")

    const input = getLastRunTaskInput()
    expect(getTagMap(input)).toEqual({
      project: "yaffle",
      managed_by: "yaffle",
      "yaffle:org-id": "org-456",
      "yaffle:org-slug": "globex",
      "yaffle:resource-class": "scanner-task",
      "yaffle:scan-job-id": "scan-job-123",
    })
  })

  test("fails closed when runner job context is missing", async () => {
    mockGetJobWithContext.mockImplementationOnce(async (_jobId: string) => undefined)
    const spawner = createSpawner()

    await expect(spawner.spawn("job-missing", "job-token-123")).rejects.toThrow(
      "Cannot spawn ECS runner task: job job-missing missing deployment context",
    )
    expect(mockSend).not.toHaveBeenCalled()
  })
})
