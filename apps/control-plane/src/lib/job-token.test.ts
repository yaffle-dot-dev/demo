import { afterEach, describe, expect, test } from "@yaffle/test"

import {
  generateJobToken,
  generateWarmRunnerToken,
  verifyJobToken,
  verifyWarmRunnerToken,
} from "./job-token.ts"

const originalJobTokenSecret = process.env.YAFFLE_JOB_TOKEN_SECRET
const originalRunTokenSecret = process.env.YAFFLE_RUN_TOKEN_SECRET

process.env.YAFFLE_PUBLIC_API_URL ??= "http://localhost:3000"

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

    const token = await generateJobToken("job-123", "deployment-123", "org-123", "lease-123")

    const payload = await verifyJobToken(token)

    expect(payload).not.toBeNull()
    expect(payload?.job_id).toBe("job-123")
    expect(payload?.deployment_id).toBe("deployment-123")
    expect(payload?.org_id).toBe("org-123")
    expect(payload?.spawn_lease_token).toBe("lease-123")
  })

  test("allows job tokens without a spawn lease token", async () => {
    process.env.YAFFLE_JOB_TOKEN_SECRET = "test-secret"

    const token = await generateJobToken("job-456", "deployment-456", "org-456", undefined)

    const payload = await verifyJobToken(token)

    expect(payload).not.toBeNull()
    expect(payload?.spawn_lease_token).toBeUndefined()
  })

  test("rejects an expired job capability", async () => {
    process.env.YAFFLE_JOB_TOKEN_SECRET = "test-secret"
    const token = await generateJobToken(
      "job-expired",
      "deployment-expired",
      "org-expired",
      undefined,
      -1,
    )

    expect(await verifyJobToken(token)).toBeNull()
  })
})

describe("warm runner tokens", () => {
  test("generates and verifies a warm runner token", async () => {
    process.env.YAFFLE_JOB_TOKEN_SECRET = "test-secret"

    const token = await generateWarmRunnerToken("org-warm-123")
    const payload = await verifyWarmRunnerToken(token)

    expect(payload).not.toBeNull()
    expect(payload?.org_id).toBe("org-warm-123")
    expect(payload?.runner_mode).toBe("warm")
  })

  test("does not accept a regular job token as a warm runner token", async () => {
    process.env.YAFFLE_JOB_TOKEN_SECRET = "test-secret"

    const token = await generateJobToken("job-789", "deployment-789", "org-789")
    const payload = await verifyWarmRunnerToken(token)

    expect(payload).toBeNull()
  })
})
