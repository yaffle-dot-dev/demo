import { Hono, type Context } from "hono"
import { z } from "zod"

import { requireAuth, AuthError } from "../lib/auth.ts"
import { auth } from "../lib/better-auth.ts"
import { getGithubIdForUser } from "../db/queries/users.ts"
import { listUserOrgs } from "../db/queries/users.ts"
import {
  listPrivateBetaInvites,
  revokePrivateBetaInvite,
  upsertPrivateBetaInvite,
} from "../db/queries/private-beta-invites.ts"
import { getPrivateBetaAccessStatusForUser } from "../lib/private-beta.ts"

export const authApiRoute = new Hono()

const createApiKeySchema = z.object({
  name: z.string().min(1).max(64),
  orgId: z.string().uuid(),
  access: z.enum(["read", "write"]),
  expiresIn: z
    .number()
    .int()
    .positive()
    .max(365 * 24 * 60 * 60),
})

const upsertPrivateBetaInviteSchema = z
  .object({
    email: z.string().email().optional(),
    githubLogin: z.string().min(1).max(64).optional(),
    note: z.string().max(500).optional(),
  })
  .refine((value) => !!value.email || !!value.githubLogin, {
    message: "email or githubLogin is required",
  })

async function requireOperator(c: Context) {
  const authContext = await requireAuth(c.req.raw.headers)
  const access = await getPrivateBetaAccessStatusForUser({
    userId: authContext.userId,
    email: authContext.email,
    githubLogin: authContext.name,
  })

  if (!access.isOperator) {
    return {
      authContext,
      error: c.json({ error: { code: "FORBIDDEN", message: "operator access required" } }, 403),
    }
  }

  return { authContext, error: null }
}

type ListedApiKey = NonNullable<Awaited<ReturnType<typeof auth.api.listApiKeys>>["apiKeys"]>[number]

authApiRoute.get("/me", async (c) => {
  try {
    const auth = await requireAuth(c.req.raw.headers)

    // Get the user's GitHub ID for matching PR authors
    const githubId = await getGithubIdForUser(auth.userId)

    return c.json({
      data: {
        userId: auth.userId,
        name: auth.name,
        email: auth.email,
        // GitHub user ID (numeric) - used for matching PR author_github_id
        githubId,
      },
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return c.json({ error: { code: err.code, message: err.message } }, 401)
    }
    return c.json({ error: { code: "UNAUTHORIZED", message: "authentication required" } }, 401)
  }
})

authApiRoute.get("/private-beta/access", async (c) => {
  try {
    const authContext = await requireAuth(c.req.raw.headers)
    const access = await getPrivateBetaAccessStatusForUser({
      userId: authContext.userId,
      email: authContext.email,
      githubLogin: authContext.name,
    })

    return c.json({ data: access })
  } catch (err) {
    if (err instanceof AuthError) {
      return c.json({ error: { code: err.code, message: err.message } }, 401)
    }
    return c.json(
      { error: { code: "INTERNAL_ERROR", message: "failed to evaluate private beta access" } },
      500,
    )
  }
})

authApiRoute.get("/private-beta/invites", async (c) => {
  try {
    const { error } = await requireOperator(c)
    if (error) return error

    return c.json({ data: await listPrivateBetaInvites() })
  } catch (err) {
    if (err instanceof AuthError) {
      return c.json({ error: { code: err.code, message: err.message } }, 401)
    }
    return c.json(
      { error: { code: "INTERNAL_ERROR", message: "failed to list private beta invites" } },
      500,
    )
  }
})

authApiRoute.post("/private-beta/invites", async (c) => {
  try {
    const { authContext, error } = await requireOperator(c)
    if (error) return error

    const body = upsertPrivateBetaInviteSchema.parse(await c.req.json())
    const invite = await upsertPrivateBetaInvite({
      email: body.email,
      githubLogin: body.githubLogin,
      note: body.note,
      invitedByUserId: authContext.userId,
    })

    return c.json({ data: invite }, 201)
  } catch (err) {
    if (err instanceof AuthError) {
      return c.json({ error: { code: err.code, message: err.message } }, 401)
    }
    if (err instanceof z.ZodError) {
      return c.json(
        {
          error: { code: "VALIDATION_ERROR", message: err.issues[0]?.message ?? "invalid request" },
        },
        400,
      )
    }
    return c.json(
      { error: { code: "INTERNAL_ERROR", message: "failed to save private beta invite" } },
      500,
    )
  }
})

authApiRoute.delete("/private-beta/invites/:inviteId", async (c) => {
  try {
    const { error } = await requireOperator(c)
    if (error) return error

    const invite = await revokePrivateBetaInvite(c.req.param("inviteId"))
    if (!invite) {
      return c.json({ error: { code: "NOT_FOUND", message: "invite not found" } }, 404)
    }

    return c.json({ data: { revoked: true } })
  } catch (err) {
    if (err instanceof AuthError) {
      return c.json({ error: { code: err.code, message: err.message } }, 401)
    }
    return c.json(
      { error: { code: "INTERNAL_ERROR", message: "failed to revoke private beta invite" } },
      500,
    )
  }
})

authApiRoute.get("/api-keys", async (c) => {
  try {
    const authContext = await requireAuth(c.req.raw.headers)
    const orgs = await listUserOrgs(authContext.userId)
    const orgMap = new Map(orgs.map((org) => [org.id, org]))

    const result = await auth.api.listApiKeys({
      headers: c.req.raw.headers,
    })

    const items = (result.apiKeys ?? []).map((key: ListedApiKey) => {
      const metadata =
        key.metadata && typeof key.metadata === "object"
          ? (key.metadata as Record<string, unknown>)
          : {}
      const scopedOrgId = typeof metadata.orgId === "string" ? metadata.orgId : null
      const org = scopedOrgId ? orgMap.get(scopedOrgId) : null

      return {
        id: key.id,
        name: key.name,
        start: key.start,
        createdAt: key.createdAt,
        expiresAt: key.expiresAt,
        enabled: key.enabled,
        access: metadata.access === "write" ? "write" : "read",
        orgId: scopedOrgId,
        orgSlug: typeof metadata.orgSlug === "string" ? metadata.orgSlug : (org?.slug ?? null),
        orgName: typeof metadata.orgName === "string" ? metadata.orgName : (org?.name ?? null),
      }
    })

    return c.json({ data: items })
  } catch (err) {
    if (err instanceof AuthError) {
      return c.json({ error: { code: err.code, message: err.message } }, 401)
    }
    return c.json({ error: { code: "INTERNAL_ERROR", message: "failed to list api keys" } }, 500)
  }
})

authApiRoute.post("/api-keys", async (c) => {
  try {
    const authContext = await requireAuth(c.req.raw.headers)
    const body = await c.req.json()
    const parsed = createApiKeySchema.safeParse(body)

    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: parsed.error.issues[0]?.message ?? "invalid request",
          },
        },
        400,
      )
    }

    const userOrgs = await listUserOrgs(authContext.userId)
    const org = userOrgs.find((item) => item.id === parsed.data.orgId)
    if (!org) {
      return c.json({ error: { code: "FORBIDDEN", message: "org access denied" } }, 403)
    }

    const permissions =
      parsed.data.access === "write" ? { yaffle: ["read", "write"] } : { yaffle: ["read"] }

    const result = await auth.api.createApiKey({
      body: {
        name: parsed.data.name,
        expiresIn: parsed.data.expiresIn,
        userId: authContext.userId,
        metadata: {
          access: parsed.data.access,
          orgId: org.id,
          orgSlug: org.slug,
          orgName: org.name,
          createdByFlow: "user_settings",
        },
        permissions,
      },
    })

    return c.json(
      {
        data: {
          id: result.id,
          key: result.key,
          name: result.name,
          expiresAt: result.expiresAt,
          access: parsed.data.access,
          orgId: org.id,
          orgSlug: org.slug,
          orgName: org.name,
        },
      },
      201,
    )
  } catch (err) {
    if (err instanceof AuthError) {
      return c.json({ error: { code: err.code, message: err.message } }, 401)
    }
    if (err instanceof z.ZodError) {
      return c.json(
        {
          error: { code: "VALIDATION_ERROR", message: err.issues[0]?.message ?? "invalid request" },
        },
        400,
      )
    }
    console.error("failed to create api key", err)
    return c.json({ error: { code: "INTERNAL_ERROR", message: "failed to create api key" } }, 500)
  }
})

authApiRoute.delete("/api-keys/:keyId", async (c) => {
  try {
    await requireAuth(c.req.raw.headers)
    await auth.api.deleteApiKey({
      headers: c.req.raw.headers,
      body: {
        keyId: c.req.param("keyId"),
      },
    })
    return c.json({ data: { deleted: true } })
  } catch (err) {
    if (err instanceof AuthError) {
      return c.json({ error: { code: err.code, message: err.message } }, 401)
    }
    return c.json({ error: { code: "INTERNAL_ERROR", message: "failed to delete api key" } }, 500)
  }
})
