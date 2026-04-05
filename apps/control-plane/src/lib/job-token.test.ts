import { afterEach, describe, expect, test } from "bun:test"

import { generateJobToken, verifyJobToken } from "./job-token.ts"

const originalJobTokenSecret = process.env.YAFFLE_JOB_TOKEN_SECRET
const originalRunTokenSecret = process.env.YAFFLE_RUN_TOKEN_SECRET

afterEach(() => {
  if (originalJobTokenSecret === undefined) {
    delete process.env.YAFFLE_JOB_TOKEN_SECRET
  } else {
    process.env.YAFFLE_JOB_TOKEN_SECRET = originalJobTokenSecret
  }

  if (originalRunTokenSecret === undefined) {
    delete process.env.YAFFLE_RUN_TOKEN_SECRET
  } else {
    process.env.YAFFLE_RUN_TOKEN_SECRET = originalRunTokenSecret
  }
})

describe("job token leases", () => {
  test("preserves spawn lease token in generated job tokens", async () => {
    process.env.YAFFLE_JOB_TOKEN_SECRET = "test-secret"

    const token = await generateJobToken(
      "job-123",
      "deployment-123",
      "org-123",
      "lease-123",
    )

    const payload = await verifyJobToken(token)

    expect(payload).not.toBeNull()
    expect(payload?.job_id).toBe("job-123")
    expect(payload?.deployment_id).toBe("deployment-123")
    expect(payload?.org_id).toBe("org-123")
    expect(payload?.spawn_lease_token).toBe("lease-123")
  })

  test("allows job tokens without a spawn lease token", async () => {
    process.env.YAFFLE_JOB_TOKEN_SECRET = "test-secret"

    const token = await generateJobToken(
      "job-456",
      "deployment-456",
      "org-456",
      undefined,
    )

    const payload = await verifyJobToken(token)

    expect(payload).not.toBeNull()
    expect(payload?.spawn_lease_token).toBeUndefined()
  })
})
