import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { createHash } from "node:crypto"

import {
  createApiToken,
  deleteApiTokensByUserId,
  generateToken,
  getDefaultTfcScopesForRole,
} from "../../db/queries/api-tokens.ts"
import { createOrg, findOrgBySlug } from "../../db/queries/organizations.ts"
import { deleteWorkspace, findWorkspaceByName } from "../../db/queries/workspaces.ts"
import { ensureMembership } from "../../db/queries/users.ts"
import { db } from "../../lib/db.ts"
import { repositories, user } from "../../db/schema.ts"
import { generateRunToken } from "../../lib/run-token.ts"

const mockFetchFileContent = mock(async () => undefined as string | undefined)
const mockCheckTeamMembership = mock(async () => false)
const mockGetInstallationToken = mock(async () => "test-installation-token")
const mockCreateCheckRun = mock(async () => 1)
const mockUpdateCheckRun = mock(async () => {})
const mockUpsertPrComment = mock(async () => 1)

mock.module("../../lib/github.ts", () => ({
  fetchFileContent: mockFetchFileContent,
  checkTeamMembership: mockCheckTeamMembership,
  getInstallationToken: mockGetInstallationToken,
  createCheckRun: mockCreateCheckRun,
  updateCheckRun: mockUpdateCheckRun,
  upsertPrComment: mockUpsertPrComment,
}))

const { tfcRoute } = await import("./index.ts")

const app = new Hono()
app.route("/tfc", tfcRoute)

const PRODUCER_ORG_SLUG = "tfc-registry-producer-org"
const CONSUMER_ORG_SLUG = "tfc-registry-consumer-org"
const PRODUCER_REPO = "test-infra"
const PRODUCER_NAMESPACE = `${PRODUCER_ORG_SLUG}--${PRODUCER_REPO}`
const CONSUMER_REPO_NAME = "foo-service"
const PRODUCER_WORKSPACE_NAME = "tfc-registry-producer-workspace"
const CONSUMER_WORKSPACE_NAME = "tfc-registry-consumer-workspace"
const PRODUCER_USER_ID = "tfc-registry-producer-user"
const CONSUMER_USER_ID = "tfc-registry-consumer-user"

let producerOrgId: string
let consumerOrgId: string
let producerUserToken: string
let consumerUserToken: string

async function ensureTestUserRecord(id: string, name: string, email: string): Promise<void> {
  const existingUser = await db.select().from(user).where(eq(user.id, id)).limit(1)
  if (existingUser.length === 0) {
    await db.insert(user).values({
      id,
      name,
      email,
      emailVerified: true,
    })
  }
}

async function mintApiToken(
  userId: string,
  description: string,
  orgId: string,
): Promise<string> {
  const { token, hash } = generateToken()
  await createApiToken({
    userId,
    orgId,
    scopes: getDefaultTfcScopesForRole("admin"),
    createdByFlow: "test",
    tokenHash: hash,
    description,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  })
  return token
}

function authRequest(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Request {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json"
  }

  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
}

function md5(content: string | Uint8Array): string {
  return createHash("md5").update(content).digest("hex")
}

async function upsertRepository(params: {
  orgId: string
  githubId: number
  installationId: number
  name: string
  fullName: string
}): Promise<void> {
  await db
    .insert(repositories)
    .values({
      orgId: params.orgId,
      githubId: params.githubId,
      installationId: params.installationId,
      name: params.name,
      fullName: params.fullName,
      defaultBranch: "main",
      isActive: true,
    })
    .onConflictDoUpdate({
      target: repositories.githubId,
      set: {
        orgId: params.orgId,
        installationId: params.installationId,
        name: params.name,
        fullName: params.fullName,
        isActive: true,
      },
    })
}

async function createWorkspaceForOrg(params: {
  orgSlug: string
  token: string
  name: string
  repo: string
  workspacePath: string
  environment?: string
}): Promise<string> {
  const res = await app.fetch(
    authRequest(
      "POST",
      `/tfc/api/v2/organizations/${params.orgSlug}/workspaces`,
      params.token,
      {
        data: {
          type: "workspaces",
          attributes: {
            name: params.name,
            repo: params.repo,
            environment: params.environment ?? "main",
            "workspace-path": params.workspacePath,
          },
        },
      },
    ),
  )

  expect(res.status).toBe(201)
  const body = await res.json()
  return body.data.id
}

async function uploadState(params: {
  workspaceId: string
  token: string
  state: string
  serial?: number
}): Promise<void> {
  await app.fetch(
    authRequest(
      "POST",
      `/tfc/api/v2/workspaces/${params.workspaceId}/actions/lock`,
      params.token,
    ),
  )

  const serial = params.serial ?? 1
  const svRes = await app.fetch(
    authRequest(
      "POST",
      `/tfc/api/v2/workspaces/${params.workspaceId}/state-versions`,
      params.token,
      {
        data: {
          type: "state-versions",
          attributes: {
            serial,
            md5: md5(params.state),
            lineage: "12345678-1234-1234-1234-123456789012",
          },
        },
      },
    ),
  )

  expect(svRes.status).toBe(201)
  const svBody = await svRes.json()
  const uploadPath = new URL(svBody.data.attributes["hosted-state-upload-url"]).pathname

  const uploadRes = await app.fetch(
    new Request(`http://localhost${uploadPath}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${params.token}`,
        "Content-Type": "application/json",
      },
      body: params.state,
    }),
  )

  expect(uploadRes.status).toBe(200)
}

beforeAll(async () => {
  await ensureTestUserRecord(PRODUCER_USER_ID, "Registry Producer User", "registry-producer@example.com")
  await ensureTestUserRecord(CONSUMER_USER_ID, "Registry Consumer User", "registry-consumer@example.com")

  let producerOrg = await findOrgBySlug(PRODUCER_ORG_SLUG)
  if (!producerOrg) {
    producerOrg = await createOrg({
      name: "Registry Producer Org",
      slug: PRODUCER_ORG_SLUG,
    })
  }
  producerOrgId = producerOrg.id

  let consumerOrg = await findOrgBySlug(CONSUMER_ORG_SLUG)
  if (!consumerOrg) {
    consumerOrg = await createOrg({
      name: "Registry Consumer Org",
      slug: CONSUMER_ORG_SLUG,
    })
  }
  consumerOrgId = consumerOrg.id

  await ensureMembership({
    orgId: producerOrgId,
    userId: PRODUCER_USER_ID,
    role: "admin",
    source: "manual",
  })

  await ensureMembership({
    orgId: consumerOrgId,
    userId: CONSUMER_USER_ID,
    role: "admin",
    source: "manual",
  })

  await deleteApiTokensByUserId(PRODUCER_USER_ID)
  await deleteApiTokensByUserId(CONSUMER_USER_ID)

  producerUserToken = await mintApiToken(PRODUCER_USER_ID, "Registry producer token", producerOrgId)
  consumerUserToken = await mintApiToken(CONSUMER_USER_ID, "Registry consumer token", consumerOrgId)
})

afterAll(async () => {
  await deleteApiTokensByUserId(PRODUCER_USER_ID)
  await deleteApiTokensByUserId(CONSUMER_USER_ID)
  mock.restore()
})

beforeEach(async () => {
  mockFetchFileContent.mockImplementation(async () => undefined)

  for (const [orgId, workspaceName] of [
    [producerOrgId, PRODUCER_WORKSPACE_NAME],
    [consumerOrgId, CONSUMER_WORKSPACE_NAME],
  ] as const) {
    const existing = await findWorkspaceByName(orgId, workspaceName)
    if (existing) {
      await deleteWorkspace(existing.id)
    }
  }

  await upsertRepository({
    orgId: producerOrgId,
    githubId: 910001,
    installationId: 1001,
    name: PRODUCER_REPO,
    fullName: "yaffle-dot-dev/test-infra",
  })

  await upsertRepository({
    orgId: consumerOrgId,
    githubId: 910002,
    installationId: 1002,
    name: CONSUMER_REPO_NAME,
    fullName: "other-github/foo-service",
  })
})

describe("Module Registry cross-org auth", () => {
  const producerState = JSON.stringify({
    version: 4,
    terraform_version: "1.12.0",
    serial: 1,
    lineage: "12345678-1234-1234-1234-123456789012",
    outputs: {
      connection_string: {
        value: "postgres://example",
        type: "string",
      },
      internal_only: {
        value: "hidden",
        type: "string",
      },
    },
    resources: [],
  })

  test("allows allowlisted cross-org consumers to download a module", async () => {
    mockFetchFileContent.mockImplementation(async () => `
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "platform/database"
environments = ["main"]

outputs.connection_string = { visibility = "public", consumers = ["${CONSUMER_ORG_SLUG}:other-github/foo-service:apps/api/infra"] }
`)

    const producerWorkspaceId = await createWorkspaceForOrg({
      orgSlug: PRODUCER_ORG_SLUG,
      token: producerUserToken,
      name: PRODUCER_WORKSPACE_NAME,
      repo: PRODUCER_REPO,
      workspacePath: "platform/database",
    })
    await uploadState({
      workspaceId: producerWorkspaceId,
      token: producerUserToken,
      state: producerState,
    })

    const consumerWorkspaceId = await createWorkspaceForOrg({
      orgSlug: CONSUMER_ORG_SLUG,
      token: consumerUserToken,
      name: CONSUMER_WORKSPACE_NAME,
      repo: CONSUMER_REPO_NAME,
      workspacePath: "apps/api/infra",
    })

    const runToken = await generateRunToken("cross-org-allow", consumerWorkspaceId, consumerOrgId)

    const downloadRes = await app.fetch(
      authRequest(
        "GET",
        `/tfc/registry/v1/modules/${PRODUCER_NAMESPACE}/platform--database/yaffle/1.0.1/download`,
        runToken,
      ),
    )

    expect(downloadRes.status).toBe(204)
    const archiveUrl = downloadRes.headers.get("X-Terraform-Get")
    expect(archiveUrl).toBeTruthy()

    const archiveRes = await app.fetch(
      new Request(`http://localhost${archiveUrl}`, {
        method: "GET",
      }),
    )

    expect(archiveRes.status).toBe(200)
    expect(archiveRes.headers.get("Content-Type")).toBe("application/gzip")
  })

  test("denies cross-org consumers that are not allowlisted", async () => {
    mockFetchFileContent.mockImplementation(async () => `
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "platform/database"
environments = ["main"]

outputs.connection_string = { visibility = "public", consumers = ["another-org:other-github/foo-service:apps/api/infra"] }
`)

    const producerWorkspaceId = await createWorkspaceForOrg({
      orgSlug: PRODUCER_ORG_SLUG,
      token: producerUserToken,
      name: PRODUCER_WORKSPACE_NAME,
      repo: PRODUCER_REPO,
      workspacePath: "platform/database",
    })
    await uploadState({
      workspaceId: producerWorkspaceId,
      token: producerUserToken,
      state: producerState,
    })

    const consumerWorkspaceId = await createWorkspaceForOrg({
      orgSlug: CONSUMER_ORG_SLUG,
      token: consumerUserToken,
      name: CONSUMER_WORKSPACE_NAME,
      repo: CONSUMER_REPO_NAME,
      workspacePath: "apps/api/infra",
    })

    const runToken = await generateRunToken("cross-org-deny", consumerWorkspaceId, consumerOrgId)

    const versionsRes = await app.fetch(
      authRequest(
        "GET",
        `/tfc/registry/v1/modules/${PRODUCER_NAMESPACE}/platform--database/yaffle/versions`,
        runToken,
      ),
    )

    expect(versionsRes.status).toBe(403)
    const body = await versionsRes.json()
    expect(body.errors[0].title).toBe("Module not exported to this workspace")
  })
})
