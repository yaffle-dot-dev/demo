import { Hono } from "hono"

export const previewsRoute = new Hono()

previewsRoute.get("/", (c) => {
  // TODO: list previews
  return c.json({ data: [] })
})

previewsRoute.get("/:id", (c) => {
  const id = c.req.param("id")
  // TODO: get preview by id
  return c.json({ error: { code: "NOT_IMPLEMENTED", message: `preview ${id} lookup not yet implemented` } }, 501)
})
