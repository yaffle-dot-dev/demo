import { afterAll, beforeAll, expect, test } from "@yaffle/test"
import { Hono } from "hono"

import { previews, tfRuns } from "../db/schema.ts"
import { db } from "../lib/db.ts"
import {
  authHeaders,
  cleanupTestData,
  createTestContext,
  type TestContext,
} from "../test-utils/auth.ts"
import { runsRoute } from "./runs.ts"

const app = new Hono()
app.route("/api/runs", runsRoute)

let context: TestContext

beforeAll(async () => {
  context = await createTestContext({ orgSlug: "run-mutation-auth" })
})

afterAll(async () => {
  await cleanupTestData()
})

test("denies viewers from cancelling infrastructure runs", async () => {
  const [deployment] = await db
    .insert(previews)
    .values({
      orgId: context.org.id,
      repo: "fixture",
      environmentKind: "named",
      environmentName: "main",
      workspacePath: "infra",
      ref: "refs/heads/main",
      headSha: "abc123",
      status: "applying",
      stateKey: "main/infra/terraform.tfstate",
      mode: "saas",
    })
    .returning()
  const [run] = await db
    .insert(tfRuns)
    .values({
      deploymentId: deployment.id,
      runType: "apply",
      status: "running",
    })
    .returning()

  const response = await app.request(`/api/runs/${run.id}/cancel`, {
    method: "POST",
    headers: authHeaders({
      userId: context.user.id,
      email: context.user.email,
      orgId: context.org.id,
      role: "viewer",
    }),
  })

  expect(response.status).toBe(403)
})
