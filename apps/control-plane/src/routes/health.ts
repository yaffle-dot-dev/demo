import { Hono } from "hono"

export const healthRoute = new Hono()

healthRoute.get("/health", (c) => {
  return c.json({ data: { status: "ok" } })
})
