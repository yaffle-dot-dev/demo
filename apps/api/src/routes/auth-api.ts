import { Hono } from "hono"

import { requireAuth, AuthError } from "../lib/auth.ts"

export const authApiRoute = new Hono()

authApiRoute.get("/me", async (c) => {
  try {
    const auth = await requireAuth(c.req.raw.headers)
    return c.json({
      data: {
        userId: auth.userId,
        login: auth.login,
        provider: auth.provider,
      },
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return c.json({ error: { code: err.code, message: err.message } }, 401)
    }
    return c.json({ error: { code: "UNAUTHORIZED", message: "authentication required" } }, 401)
  }
})
