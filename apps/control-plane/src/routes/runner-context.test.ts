import { afterEach, beforeEach, expect, test } from "@yaffle/test"

import { Hono } from "hono"
import { sql } from "drizzle-orm"

import { createOrg } from "../db/queries/organizations.ts"
import { createRunGroup } from "../db/queries/run-groups.ts"
import { iacJobs, previews } from "../db/schema.ts"
import { cleanupTestData } from "../test-utils/auth.ts"
import { db } from "../lib/db.ts"
import { generateJobToken } from "../lib/job-token.ts"
import { runnerRoute } from "./runner.ts"

const app = new Hono()
app.route("/api/runner", runnerRoute)

beforeEach(async () => {
  await cleanupTestData()
})

afterEach(async () => {
  await cleanupTestData()
})

test("does not expose or claim a transient job without a valid execution context", async () => {
  const org = await createOrg({
    name: "Invalid Runner Context",
    slug: `invalid-runner-context-${crypto.randomUUID()}`,
  })
  const [deployment] = await db
    .insert(previews)
    .values({
      orgId: org.id,
      repo: "fixture",
      environmentKind: "transient",
      environmentName: "pr-9",
      prNumber: 9,
      workspacePath: "infra",
      ref: "refs/heads/feature/invalid-context",
      headSha: "invalid-context-sha",
      stateKey: "previews/pr-9/terraform.tfstate",
      mode: "saas",
    })
    .returning()
  const jobId = crypto.randomUUID()
  const runGroup = await createRunGroup({
    orgId: org.id,
    repo: deployment.repo,
    environmentKind: "transient",
    environmentName: deployment.environmentName,
    prNumber: deployment.prNumber,
    ref: deployment.ref,
    headSha: deployment.headSha,
    trigger: "pr_opened",
    status: "failed",
  })
  await db.execute(sql`
    INSERT INTO iac_jobs (id, deployment_id, run_group_id, job_type, status)
    VALUES (${jobId}, ${deployment.id}, ${runGroup.id}, 'plan', 'queued')
  `)
  const token = await generateJobToken(jobId, deployment.id, org.id)
  const headers = { authorization: `Bearer ${token}` }

  const detailsResponse = await app.request(`/api/runner/job/${jobId}`, { headers })
  expect(detailsResponse.status).toBe(409)
  expect(await detailsResponse.json()).toMatchObject({
    error: { code: "EXECUTION_CONTEXT_INVALID" },
  })

  const claimResponse = await app.request("/api/runner/claim", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ jobId, workerId: "test-worker" }),
  })
  expect(claimResponse.status).toBe(409)
  expect(await claimResponse.json()).toMatchObject({
    error: { code: "EXECUTION_CONTEXT_INVALID" },
  })

  const [persistedJob] = await db.select().from(iacJobs)
  expect(persistedJob.status).toBe("queued")
})
