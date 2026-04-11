import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Hono } from "hono"

import { findPrivateBetaInviteByIdentity } from "../db/queries/private-beta-invites.ts"
import { betaAccessInvites } from "../db/schema.ts"
import { db } from "../lib/db.ts"
import { authHeaders, cleanupTestData, createTestUser, type TestUser } from "../test-utils/auth.ts"
import { authApiRoute } from "./auth-api.ts"
import { orgsRoute } from "./orgs.ts"

const app = new Hono()
app.route("/api/orgs", orgsRoute)
app.route("/api/users", authApiRoute)

let operatorUser: TestUser
let invitedUser: TestUser
let strangerUser: TestUser

function headersFor(user: TestUser): Headers {
  return authHeaders({
    userId: user.id,
    email: user.email,
    name: user.name,
    orgId: "",
    role: "viewer",
  })
}

async function reqAs(user: TestUser, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = headersFor(user)
  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  }

  return app.request(path, {
    ...init,
    headers,
  })
}

beforeEach(async () => {
  process.env.YAFFLE_PRIVATE_BETA_INVITES_REQUIRED = "true"
  const suffix = crypto.randomUUID().slice(0, 8)

  process.env.YAFFLE_PRIVATE_BETA_OPERATOR_IDENTIFIERS = `operator-${suffix}@test.yaffle.dev,operator-login-${suffix}`

  operatorUser = await createTestUser({
    email: `operator-${suffix}@test.yaffle.dev`,
    name: `operator-login-${suffix}`,
  })
  invitedUser = await createTestUser({
    email: `friend-${suffix}@test.yaffle.dev`,
    name: `friend-login-${suffix}`,
  })
  strangerUser = await createTestUser({
    email: `stranger-${suffix}@test.yaffle.dev`,
    name: `stranger-login-${suffix}`,
  })
})

afterEach(async () => {
  delete process.env.YAFFLE_PRIVATE_BETA_INVITES_REQUIRED
  delete process.env.YAFFLE_PRIVATE_BETA_OPERATOR_IDENTIFIERS
  await cleanupTestData()
})

describe("private beta invites", () => {
  test("blocks org creation for uninvited users", async () => {
    const res = await reqAs(strangerUser, "/api/orgs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Blocked Org",
        slug: "blocked-org",
      }),
    })

    expect(res.status).toBe(403)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe("PRIVATE_BETA_CLOSED")
  })

  test("operator can create invite and invited user can claim it by creating an org", async () => {
    const createInviteRes = await reqAs(operatorUser, "/api/users/private-beta/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: invitedUser.email,
        githubLogin: invitedUser.name,
        note: "first friend",
      }),
    })

    expect(createInviteRes.status).toBe(201)

    const accessRes = await reqAs(invitedUser, "/api/users/private-beta/access")
    expect(accessRes.status).toBe(200)
    const accessBody = await accessRes.json() as {
      data: { hasAccess: boolean; matchedBy: string | null; invite: { id: string } | null }
    }
    expect(accessBody.data.hasAccess).toBe(true)
    expect(["email", "github_login"]).toContain(accessBody.data.matchedBy ?? "")
    expect(accessBody.data.invite?.id).toBeTruthy()

    const createOrgRes = await reqAs(invitedUser, "/api/orgs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Invited Org",
        slug: "invited-org",
      }),
    })

    expect(createOrgRes.status).toBe(201)

    const invite = await findPrivateBetaInviteByIdentity({
      email: invitedUser.email,
      githubLogin: invitedUser.name,
    })
    expect(invite?.claimedByUserId).toBe(invitedUser.id)
    expect(invite?.claimedAt).not.toBeNull()
  })

  test("operator can list and revoke invites", async () => {
    const createInviteRes = await reqAs(operatorUser, "/api/users/private-beta/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        githubLogin: "another-friend",
      }),
    })
    expect(createInviteRes.status).toBe(201)
    const createdInvite = await createInviteRes.json() as { data: { id: string } }

    const listRes = await reqAs(operatorUser, "/api/users/private-beta/invites")
    expect(listRes.status).toBe(200)
    const listBody = await listRes.json() as { data: Array<{ id: string; githubLogin: string | null }> }
    expect(listBody.data.some((invite) => invite.id === createdInvite.data.id && invite.githubLogin === "another-friend")).toBe(true)

    const revokeRes = await reqAs(operatorUser, `/api/users/private-beta/invites/${createdInvite.data.id}`, {
      method: "DELETE",
    })
    expect(revokeRes.status).toBe(200)

    const revokedInviteRows = await db
      .select()
      .from(betaAccessInvites)
      .where(eq(betaAccessInvites.id, createdInvite.data.id))
      .limit(1)
    expect(revokedInviteRows[0]?.revokedAt).not.toBeNull()
  })
})
