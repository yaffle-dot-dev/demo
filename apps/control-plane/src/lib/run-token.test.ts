import { afterEach, describe, expect, test } from "@yaffle/test"

import { generateRunToken, getMergeImpactRunTokenScopes, verifyRunToken } from "./run-token.ts"

const originalRunTokenSecret = process.env.YAFFLE_RUN_TOKEN_SECRET
process.env.YAFFLE_PUBLIC_API_URL ??= "http://localhost:3000"

afterEach(() => {
  if (originalRunTokenSecret === undefined) {
    delete process.env.YAFFLE_RUN_TOKEN_SECRET
  } else {
    process.env.YAFFLE_RUN_TOKEN_SECRET = originalRunTokenSecret
  }
})

describe("getMergeImpactRunTokenScopes", () => {
  test("cannot lock or write named environment state", () => {
    expect(getMergeImpactRunTokenScopes()).toEqual([
      "workspace:read",
      "state:read",
      "state:download",
    ])
  })
})

describe("run token capabilities", () => {
  test("binds the exact run, job, deployment, run group, workspace, and organization", async () => {
    process.env.YAFFLE_RUN_TOKEN_SECRET = "test-run-token-secret"
    const capability = {
      runId: crypto.randomUUID(),
      jobId: crypto.randomUUID(),
      deploymentId: crypto.randomUUID(),
      runGroupId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      orgId: crypto.randomUUID(),
    }

    const payload = await verifyRunToken(await generateRunToken(capability))

    expect(payload).toMatchObject({
      sub: `run:${capability.runId}`,
      run_id: capability.runId,
      job_id: capability.jobId,
      deployment_id: capability.deploymentId,
      run_group_id: capability.runGroupId,
      workspace_id: capability.workspaceId,
      org_id: capability.orgId,
    })
  })

  test("rejects an expired run capability", async () => {
    process.env.YAFFLE_RUN_TOKEN_SECRET = "test-run-token-secret"
    const token = await generateRunToken({
      runId: crypto.randomUUID(),
      jobId: crypto.randomUUID(),
      deploymentId: crypto.randomUUID(),
      runGroupId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      orgId: crypto.randomUUID(),
      ttlHours: -1,
    })

    expect(await verifyRunToken(token)).toBeNull()
  })
})
