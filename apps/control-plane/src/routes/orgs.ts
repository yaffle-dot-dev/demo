import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

import { requireAuth, AuthError } from "../lib/auth.ts"
import { getEnv } from "../lib/env.ts"
import { listUserOrgs } from "../db/queries/users.ts"
import { findOrgBySlug, findOrgMembership } from "../db/queries/organizations.ts"

export const orgsRoute = new Hono()

/**
 * GET /api/orgs
 *
 * List all organizations the current user belongs to.
 * This endpoint requires authentication but is NOT org-scoped (it lists all orgs).
 */
orgsRoute.get("/", async (c) => {
  const env = getEnv()

  let auth
  try {
    auth = await requireAuth(c.req.raw.headers)
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.code === "AUTH_REQUIRED" ? 401 : 403
      return c.json({ error: { code: err.code, message: err.message } }, status)
    }
    throw err
  }

  // In dev mode, return the single org from headers
  if (env.authMode === "dev" && auth.orgId && auth.role) {
    const orgSlug = c.req.header("x-yaffle-org") ?? auth.name
    return c.json({
      data: [
        {
          id: auth.orgId,
          slug: orgSlug,
          name: orgSlug,
          role: auth.role,
          source: "admin_bootstrap",
        },
      ],
    })
  }

  // Production mode - list from database
  const orgs = await listUserOrgs(auth.userId)
  return c.json({ data: orgs })
})

/**
 * GET /api/orgs/stream
 *
 * SSE stream for user's org list. Pushes updates when orgs change.
 */
orgsRoute.get("/stream", async (c) => {
  const token = c.req.query("token")

  let auth
  try {
    auth = await requireAuth(c.req.raw.headers, { token })
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.code === "AUTH_REQUIRED" ? 401 : 403
      return c.json({ error: { code: err.code, message: err.message } }, status)
    }
    throw err
  }

  const userId = auth.userId

  return streamSSE(c, async (stream) => {
    let lastPayload = ""
    let inFlight = false

    const sendSnapshot = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        const orgs = await listUserOrgs(userId)
        const payload = JSON.stringify({ data: orgs })

        if (payload !== lastPayload) {
          lastPayload = payload
          await stream.writeSSE({ event: "update", data: payload })
        }
      } finally {
        inFlight = false
      }
    }

    await sendSnapshot()

    const interval = setInterval(sendSnapshot, 2000)

    // Block the callback so Hono doesn't call stream.close() in its
    // finally block.  Resolves only when the client disconnects.
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(interval)
        resolve()
      })
    })
  })
})

/**
 * GET /api/orgs/:slug/status/stream
 *
 * SSE stream for org provisioning status. Pushes updates as the org
 * transitions through pending -> provisioning -> active/failed.
 */
orgsRoute.get("/:slug/status/stream", async (c) => {
  const slug = c.req.param("slug")
  const token = c.req.query("token")

  let auth
  try {
    auth = await requireAuth(c.req.raw.headers, { token })
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.code === "AUTH_REQUIRED" ? 401 : 403
      return c.json({ error: { code: err.code, message: err.message } }, status)
    }
    throw err
  }

  // Find the org
  const org = await findOrgBySlug(slug)
  if (!org) {
    return c.json({ error: { code: "NOT_FOUND", message: "Organization not found" } }, 404)
  }

  // Check membership
  const membership = await findOrgMembership(org.id, auth.userId)
  if (!membership) {
    return c.json({ error: { code: "FORBIDDEN", message: "Not a member of this organization" } }, 403)
  }

  return streamSSE(c, async (stream) => {
    let lastPayload = ""
    let inFlight = false

    const sendSnapshot = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        // Re-fetch org to get latest status
        const currentOrg = await findOrgBySlug(slug)
        if (!currentOrg) return

        const payload = JSON.stringify({
          data: {
            id: currentOrg.id,
            slug: currentOrg.slug,
            name: currentOrg.name,
            provisioningStatus: currentOrg.provisioningStatus,
            provisioningError: currentOrg.provisioningError,
            provisioningAttempts: currentOrg.provisioningAttempts,
          },
        })

        if (payload !== lastPayload) {
          lastPayload = payload
          await stream.writeSSE({ event: "update", data: payload })
        }
      } finally {
        inFlight = false
      }
    }

    await sendSnapshot()

    // Poll every 2s for status updates
    const interval = setInterval(sendSnapshot, 2000)

    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(interval)
        resolve()
      })
    })
  })
})
