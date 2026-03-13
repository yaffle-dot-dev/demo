import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  buildTfcEnvVars,
  writeEphemeralCredentials,
} from "./tfc-backend.ts"

describe("buildTfcEnvVars", () => {
  const originalEnv = process.env.YAFFLE_TFC_API_HOST

  beforeEach(() => {
    process.env.YAFFLE_TFC_API_HOST = "yaffle.local:6969"
  })

  afterEach(() => {
    if (originalEnv) {
      process.env.YAFFLE_TFC_API_HOST = originalEnv
    } else {
      delete process.env.YAFFLE_TFC_API_HOST
    }
  })

  test("returns TF_TOKEN env var for hostname", () => {
    const envVars = buildTfcEnvVars("test-token")

    expect(envVars.TF_TOKEN_yaffle_local_6969).toBe("test-token")
    expect(envVars.YAFFLE_TFC_API_HOST).toBe("yaffle.local:6969")
  })

  test("includes TF_CLI_CONFIG_FILE when credentialsPath provided", () => {
    const envVars = buildTfcEnvVars("test-token", "/tmp/creds.json")

    expect(envVars.TF_TOKEN_yaffle_local_6969).toBe("test-token")
    expect(envVars.TF_CLI_CONFIG_FILE).toBe("/tmp/creds.json")
  })

  test("omits TF_CLI_CONFIG_FILE when no credentialsPath", () => {
    const envVars = buildTfcEnvVars("test-token")

    expect(envVars.TF_CLI_CONFIG_FILE).toBeUndefined()
  })
})

describe("writeEphemeralCredentials", () => {
  const originalEnv = process.env.YAFFLE_TFC_API_HOST
  let tempDir: string

  beforeEach(async () => {
    process.env.YAFFLE_TFC_API_HOST = "yaffle.local:6969"
    tempDir = await mkdtemp(join(tmpdir(), "yaffle-test-"))
  })

  afterEach(async () => {
    if (originalEnv) {
      process.env.YAFFLE_TFC_API_HOST = originalEnv
    } else {
      delete process.env.YAFFLE_TFC_API_HOST
    }
    await rm(tempDir, { recursive: true, force: true })
  })

  test("writes credentials file in .yaffle subdirectory", async () => {
    const credentialsPath = await writeEphemeralCredentials(tempDir, "my-jwt-token")

    expect(credentialsPath).toBe(join(tempDir, ".yaffle", "credentials.tfrc.json"))

    const content = await readFile(credentialsPath, "utf-8")
    const parsed = JSON.parse(content)

    expect(parsed).toEqual({
      credentials: {
        "yaffle.local:6969": {
          token: "my-jwt-token",
        },
      },
    })
  })

  test("creates .yaffle directory if it does not exist", async () => {
    const credentialsPath = await writeEphemeralCredentials(tempDir, "token")

    // Should not throw - directory created automatically
    const content = await readFile(credentialsPath, "utf-8")
    expect(JSON.parse(content).credentials).toBeDefined()
  })

  test("uses hostname from YAFFLE_TFC_API_HOST", async () => {
    process.env.YAFFLE_TFC_API_HOST = "custom.host:8080"

    const credentialsPath = await writeEphemeralCredentials(tempDir, "token")
    const content = await readFile(credentialsPath, "utf-8")
    const parsed = JSON.parse(content)

    expect(parsed.credentials["custom.host:8080"]).toEqual({ token: "token" })
  })
})
