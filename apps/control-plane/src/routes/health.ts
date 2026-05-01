import { Hono } from "hono"

import { sql } from "../lib/db.ts"

export const healthRoute = new Hono()

healthRoute.get("/health", (c) => {
  return c.json({ data: { status: "ok" } })
})

healthRoute.get("/ready", async (c) => {
  try {
    await sql.unsafe("select 1 from organizations limit 1")
    await sql.unsafe("select 1 from run_group_workspace_metadata limit 1")

    return c.json({
      data: {
        status: "ready",
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    return c.json(
      {
        error: {
          code: "NOT_READY",
          message,
        },
      },
      503,
    )
  }
})
