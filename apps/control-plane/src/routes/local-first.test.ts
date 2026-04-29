import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { gunzipSync } from "node:zlib"

import { cleanupTestData } from "../test-utils/auth.ts"
import { resetRateLimitStore } from "../lib/request-protection.ts"
import { localFirstRoute } from "./local-first.ts"
import { tfcRoute } from "./tfc/index.ts"

process.env.YAFFLE_PUBLIC_API_URL ??= "http://localhost:3000"
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret-which-is-long-enough"

const TEST_FEATURE_TOKEN = "local-first-test-token"

const app = new Hono()
app.route("/api", localFirstRoute)
app.route("/tfc", tfcRoute)

describe("localFirstRoute + execution-backed module registry", () => {
  beforeEach(async () => {
    process.env.YAFFLE_LOCAL_FIRST_FEATURE_TOKEN = TEST_FEATURE_TOKEN
    resetRateLimitStore()
    await cleanupTestData()
  })

  afterEach(async () => {
    delete process.env.YAFFLE_LOCAL_FIRST_FEATURE_TOKEN
    resetRateLimitStore()
    await cleanupTestData()
  })

  test("rejects anonymous session bootstrap without the feature token", async () => {
    const sessionRes = await app.fetch(
      new Request("http://localhost/api/sessions/anonymous", { method: "POST" }),
    )

    expect(sessionRes.status).toBe(403)
    expect(await sessionRes.json()).toEqual({
      error: {
        code: "INVALID_FEATURE_TOKEN",
        message: "invalid feature token",
      },
    })
  })

  test("bootstraps anonymous session, publishes hosted module outputs, and serves them via registry", async () => {
    const sessionRes = await app.fetch(
      new Request("http://localhost/api/sessions/anonymous", {
        method: "POST",
        headers: featureHeaders(),
      }),
    )

    expect(sessionRes.status).toBe(201)
    const sessionBody = await sessionRes.json() as {
      data: {
        token: string
        principalId: string
        sessionId: string
      }
    }
    expect(sessionBody.data.principalId).toBeTruthy()
    expect(sessionBody.data.sessionId).toBeTruthy()
    expect(sessionBody.data.token).toBeTruthy()

    const publishHeaders = {
      ...featureHeaders(),
      Authorization: `Bearer ${sessionBody.data.token}`,
      "Content-Type": "application/json",
    }

    const publishV1 = await app.fetch(
      new Request("http://localhost/api/output-modules", {
        method: "PUT",
        headers: publishHeaders,
        body: JSON.stringify({
          canonicalRepoNamespace: "test-org--fixture",
          localRepoFingerprint: "repo-fingerprint-1",
          environmentName: "pr-42",
          workspacePath: "infra/shared",
          stateFingerprint: "state-md5-v1",
          outputs: {
            service_name: {
              value: "shared-v1",
              type: "string",
              sensitive: false,
            },
          },
        }),
      }),
    )

    expect(publishV1.status).toBe(201)
    expect((await publishV1.json()) as { data: { version: string } }).toEqual({
      data: expect.objectContaining({ version: "1.0.1" }),
    })

    const publishV2 = await app.fetch(
      new Request("http://localhost/api/output-modules", {
        method: "PUT",
        headers: publishHeaders,
        body: JSON.stringify({
          canonicalRepoNamespace: "test-org--fixture",
          localRepoFingerprint: "repo-fingerprint-1",
          environmentName: "pr-42",
          workspacePath: "infra/shared",
          stateFingerprint: "state-md5-v2",
          outputs: {
            service_name: {
              value: "shared-v2",
              type: "string",
              sensitive: false,
            },
            features: {
              value: ["auth", "metrics"],
              type: ["list", "string"],
              sensitive: false,
            },
          },
        }),
      }),
    )

    expect(publishV2.status).toBe(201)
    expect((await publishV2.json()) as { data: { version: string } }).toEqual({
      data: expect.objectContaining({ version: "1.0.2" }),
    })

    const executionTokenRes = await app.fetch(
      new Request("http://localhost/api/execution-tokens", {
        method: "POST",
        headers: publishHeaders,
        body: JSON.stringify({
          canonicalRepoNamespace: "test-org--fixture",
          localRepoFingerprint: "repo-fingerprint-1",
          environmentName: "pr-42",
          consumerWorkspacePath: "apps/web/infra",
        }),
      }),
    )

    expect(executionTokenRes.status).toBe(201)
    const executionTokenBody = await executionTokenRes.json() as {
      data: { token: string }
    }

    const versionsRes = await app.fetch(
      new Request(
        "http://localhost/tfc/registry/v1/modules/test-org--fixture/infra--shared/yaffle/versions",
        {
          headers: {
            Authorization: `Bearer ${executionTokenBody.data.token}`,
          },
        },
      ),
    )

    expect(versionsRes.status).toBe(200)
    expect(await versionsRes.json()).toEqual({
      modules: [
        {
          versions: [
            { version: "1.0.2" },
            { version: "1.0.1" },
          ],
        },
      ],
    })

    const downloadRes = await app.fetch(
      new Request(
        "http://localhost/tfc/registry/v1/modules/test-org--fixture/infra--shared/yaffle/1.0.2/download",
        {
          headers: {
            Authorization: `Bearer ${executionTokenBody.data.token}`,
          },
        },
      ),
    )

    expect(downloadRes.status).toBe(204)
    const archiveUrl = downloadRes.headers.get("X-Terraform-Get")
    expect(archiveUrl).toContain("/archive.tar.gz")

    const archiveRes = await app.fetch(new Request(`http://localhost${archiveUrl}`))
    expect(archiveRes.status).toBe(200)
    const archive = new Uint8Array(await archiveRes.arrayBuffer())
    const decompressed = gunzipSync(archive)
    const mainTf = extractFileFromTar(decompressed, "main.tf")

    expect(mainTf).toContain("shared-v2")
    expect(mainTf).toContain("features")
  })

  test("execution token is scoped to its canonical repo namespace", async () => {
    const sessionRes = await app.fetch(
      new Request("http://localhost/api/sessions/anonymous", {
        method: "POST",
        headers: featureHeaders(),
      }),
    )
    const sessionBody = await sessionRes.json() as { data: { token: string } }

    const publishHeaders = {
      ...featureHeaders(),
      Authorization: `Bearer ${sessionBody.data.token}`,
      "Content-Type": "application/json",
    }

    await app.fetch(
      new Request("http://localhost/api/output-modules", {
        method: "PUT",
        headers: publishHeaders,
        body: JSON.stringify({
          canonicalRepoNamespace: "test-org--fixture",
          localRepoFingerprint: "repo-fingerprint-1",
          environmentName: "main",
          workspacePath: "infra/shared",
          stateFingerprint: "state-md5-v1",
          outputs: {},
        }),
      }),
    )

    const executionTokenRes = await app.fetch(
      new Request("http://localhost/api/execution-tokens", {
        method: "POST",
        headers: publishHeaders,
        body: JSON.stringify({
          canonicalRepoNamespace: "test-org--fixture",
          localRepoFingerprint: "repo-fingerprint-1",
          environmentName: "main",
          consumerWorkspacePath: "apps/web/infra",
        }),
      }),
    )
    const executionTokenBody = await executionTokenRes.json() as {
      data: { token: string }
    }

    const versionsRes = await app.fetch(
      new Request(
        "http://localhost/tfc/registry/v1/modules/other-org--repo/infra--shared/yaffle/versions",
        {
          headers: {
            Authorization: `Bearer ${executionTokenBody.data.token}`,
          },
        },
      ),
    )

    expect(versionsRes.status).toBe(404)
  })

  test("issues a longer-lived shell-session execution token for yaffle tf login", async () => {
    const sessionRes = await app.fetch(
      new Request("http://localhost/api/sessions/anonymous", {
        method: "POST",
        headers: featureHeaders(),
      }),
    )
    const sessionBody = await sessionRes.json() as { data: { token: string } }

    const headers = {
      ...featureHeaders(),
      Authorization: `Bearer ${sessionBody.data.token}`,
      "Content-Type": "application/json",
    }

    const workspaceInitRes = await app.fetch(
      new Request("http://localhost/api/execution-tokens", {
        method: "POST",
        headers,
        body: JSON.stringify({
          canonicalRepoNamespace: "test-org--fixture",
          localRepoFingerprint: "repo-fingerprint-1",
          environmentName: "main",
          consumerWorkspacePath: "apps/web/infra",
          sessionKind: "workspace_init",
        }),
      }),
    )
    expect(workspaceInitRes.status).toBe(201)
    const workspaceInitBody = await workspaceInitRes.json() as {
      data: { expiresAt: string }
    }

    const shellSessionRes = await app.fetch(
      new Request("http://localhost/api/execution-tokens", {
        method: "POST",
        headers,
        body: JSON.stringify({
          canonicalRepoNamespace: "test-org--fixture",
          localRepoFingerprint: "repo-fingerprint-1",
          environmentName: "main",
          consumerWorkspacePath: "apps/web/infra",
          sessionKind: "shell_session",
        }),
      }),
    )
    expect(shellSessionRes.status).toBe(201)
    const shellSessionBody = await shellSessionRes.json() as {
      data: { expiresAt: string }
    }

    const workspaceInitExpiryMs = Date.parse(workspaceInitBody.data.expiresAt)
    const shellSessionExpiryMs = Date.parse(shellSessionBody.data.expiresAt)

    expect(shellSessionExpiryMs - workspaceInitExpiryMs).toBeGreaterThan(3 * 60 * 60 * 1000)
  })

  test("rate limits hosted output-module publish bursts", async () => {
    const sessionRes = await app.fetch(
      new Request("http://localhost/api/sessions/anonymous", {
        method: "POST",
        headers: {
          ...featureHeaders(),
          "x-real-ip": "198.51.100.10",
        },
      }),
    )
    const sessionBody = await sessionRes.json() as { data: { token: string } }

    const headers = {
      ...featureHeaders(),
      Authorization: `Bearer ${sessionBody.data.token}`,
      "Content-Type": "application/json",
      "x-real-ip": "198.51.100.10",
    }

    for (let index = 0; index < 120; index += 1) {
      const response = await app.fetch(
        new Request("http://localhost/api/output-modules", {
          method: "PUT",
          headers,
          body: JSON.stringify({
            canonicalRepoNamespace: "test-org--fixture",
            localRepoFingerprint: "repo-fingerprint-1",
            environmentName: "main",
            workspacePath: "infra/shared",
            stateFingerprint: `state-md5-${index}`,
            outputs: {},
          }),
        }),
      )

      expect(response.status).toBe(201)
    }

    const rateLimitedRes = await app.fetch(
      new Request("http://localhost/api/output-modules", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          canonicalRepoNamespace: "test-org--fixture",
          localRepoFingerprint: "repo-fingerprint-1",
          environmentName: "main",
          workspacePath: "infra/shared",
          stateFingerprint: "state-md5-rate-limited",
          outputs: {},
        }),
      }),
    )

    expect(rateLimitedRes.status).toBe(429)
    expect(rateLimitedRes.headers.get("Retry-After")).toBeTruthy()
    expect(await rateLimitedRes.json()).toEqual({
      error: {
        code: "RATE_LIMITED",
        message: "rate limit exceeded",
      },
    })
  })
})

function featureHeaders(): HeadersInit {
  return {
    "feature-token": TEST_FEATURE_TOKEN,
  }
}

function extractFileFromTar(tar: Buffer, filename: string): string {
  let offset = 0

  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      break
    }

    const name = header.subarray(0, 100).toString("utf-8").replace(/\0.*$/, "")
    const sizeOctal = header.subarray(124, 136).toString("utf-8").replace(/\0.*$/, "").trim()
    const size = Number.parseInt(sizeOctal || "0", 8)
    offset += 512

    if (name === filename) {
      return tar.subarray(offset, offset + size).toString("utf-8")
    }

    offset += Math.ceil(size / 512) * 512
  }

  throw new Error(`File not found in tar: ${filename}`)
}
