import { Hono } from "hono"

import { requireAuth, AuthError } from "../lib/auth.ts"
import { getGithubIdForUser } from "../db/queries/users.ts"

export const authApiRoute = new Hono()

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
