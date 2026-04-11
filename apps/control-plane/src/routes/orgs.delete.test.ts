import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Hono } from "hono"

import { createJob } from "../db/queries/jobs.ts"
import { listUserOrgs } from "../db/queries/users.ts"
import {
  githubInstallations,
  githubRepoMappings,
  jobs,
  organizations,
  repositories,
} from "../db/schema.ts"
import { db } from "../lib/db.ts"
import { cleanupTestData, createTestContext, type TestContext } from "../test-utils/auth.ts"
import { orgsRoute } from "./orgs.ts"

const app = new Hono()
app.route("/api/orgs", orgsRoute)

let adminCtx: TestContext
let viewerCtx: TestContext
let orgSlug: string

async function reqAs(ctx: TestContext, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(ctx.headers)
  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  }

  return app.request(path, {
    ...init,
    headers,
  })
}

beforeEach(async () => {
  orgSlug = `delete-org-${crypto.randomUUID().slice(0, 8)}`
  adminCtx = await createTestContext({ orgSlug, role: "admin" })
  viewerCtx = await createTestContext({ orgSlug, role: "viewer" })
})

afterEach(async () => {
  await cleanupTestData()
})

describe("org deletion", () => {
  test("deletes an org after slug confirmation while preserving install inventory", async () => {
    await db.insert(githubInstallations).values({
      orgId: adminCtx.org.id,
      githubOrgId: 101,
      githubOrgLogin: "delete-smoke-account",
      installationId: 4242,
      installedAt: new Date(),
    })

    await db.insert(repositories).values({
      orgId: adminCtx.org.id,
      installationId: 4242,
      githubId: 9001,
      name: "infra",
      fullName: "delete-smoke-account/infra",
      defaultBranch: "main",
      isActive: true,
    })

    await db.insert(githubRepoMappings).values({
      orgId: adminCtx.org.id,
      installationId: 4242,
      githubRepoId: 9001,
      createdBy: adminCtx.user.id,
    })

    const job = await createJob({
      orgId: adminCtx.org.id,
      jobType: "org_provision",
      payload: { orgId: adminCtx.org.id, orgSlug },
    })

    const res = await reqAs(adminCtx, `/api/orgs/${orgSlug}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmSlug: orgSlug }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as { data: { deleted: boolean } }
    expect(body.data.deleted).toBe(true)

    const deletedOrg = await db.select().from(organizations).where(eq(organizations.id, adminCtx.org.id)).limit(1)
    expect(deletedOrg).toHaveLength(0)

    const memberships = await listUserOrgs(adminCtx.user.id)
    expect(memberships).toEqual([])

    const installationRows = await db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, 4242))
      .limit(1)
    expect(installationRows).toHaveLength(1)
    expect(installationRows[0]?.orgId).toBeNull()

    const repositoryRows = await db
      .select()
      .from(repositories)
      .where(eq(repositories.githubId, 9001))
      .limit(1)
    expect(repositoryRows).toHaveLength(1)
    expect(repositoryRows[0]?.orgId).toBeNull()

    const mappingRows = await db
      .select()
      .from(githubRepoMappings)
      .where(eq(githubRepoMappings.githubRepoId, 9001))
    expect(mappingRows).toHaveLength(0)

    const jobRows = await db.select().from(jobs).where(eq(jobs.id, job.id)).limit(1)
    expect(jobRows).toHaveLength(0)
  })

  test("rejects deletion when the slug confirmation does not match", async () => {
    const res = await reqAs(adminCtx, `/api/orgs/${orgSlug}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmSlug: "wrong-org" }),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe("CONFIRMATION_MISMATCH")
  })

  test("rejects deletion for non-admin members", async () => {
    const res = await reqAs(viewerCtx, `/api/orgs/${orgSlug}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmSlug: orgSlug }),
    })

    expect(res.status).toBe(403)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe("FORBIDDEN")
  })
})
