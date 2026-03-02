import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

import { requireAuth, AuthError } from "../lib/auth.ts"
import { getEnv } from "../lib/env.ts"
import { listUserOrgs } from "../db/queries/users.ts"

export const orgsRoute = new Hono()

/**
 * GET /api/orgs
 *
 * List all organizations the current user belongs to.
 * This endpoint requires authentication but is NOT org-scoped (it lists all orgs).
 */
orgsRoute.get("/", async (c) => {
  const env = getEnv()

  // This endpoint always requires auth (even if authMode is "off" for other endpoints)
  if (env.authMode === "off") {
    return c.json({ error: { code: "UNAUTHORIZED", message: "authentication required" } }, 401)
  }

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
    const orgLogin = c.req.header("x-yaffle-org") ?? auth.login
    return c.json({
      data: [
        {
          id: auth.orgId,
          login: orgLogin,
          role: auth.role,
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
  const env = getEnv()
  const token = c.req.query("token")

  if (env.authMode === "off") {
    return c.json({ error: { code: "UNAUTHORIZED", message: "authentication required" } }, 401)
  }

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

    stream.onAbort(() => {
      clearInterval(interval)
    })
  })
})
