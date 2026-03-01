import { Hono } from "hono"
import { logger } from "hono/logger"

import { webhooksRoute } from "./routes/webhooks.ts"
import { previewsRoute } from "./routes/previews.ts"
import { healthRoute } from "./routes/health.ts"

const app = new Hono()

app.use("*", logger())

app.route("/api/webhooks", webhooksRoute)
app.route("/api/previews", previewsRoute)
app.route("/api", healthRoute)

const port = Number(process.env.PORT ?? 3000)

console.log(`yaffle api listening on :${port}`)

export default {
  port,
  fetch: app.fetch,
}
