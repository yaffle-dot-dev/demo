import { afterEach, describe, expect, test, vi } from "@yaffle/test"

import { YaffleClient } from "./client.js"
import type { AuthProvider } from "./auth.js"

const auth: AuthProvider = {
  async getCredentials() {
    return { accessToken: "test-token" }
  },
  async isAuthenticated() {
    return true
  },
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe("YaffleClient.getOutputs", () => {
  test("returns latest apply outputs while workspace is activating", async () => {
    const fetchMock = mockWorkspaceDetails({
      status: "activating",
      outputs: {
        web_service_name: { value: "yaffle-web" },
      },
    })
    const client = new YaffleClient({
      apiUrl: "https://yaffle.test",
      auth,
      logger,
    })

    const result = await client.getOutputs({
      org: "yaffle-dot-dev",
      repo: "yaffle",
      target: { type: "env", name: "main" },
      workspace: "apps/web/infra",
    })

    expect(result.status).toBe("activating")
    expect(result.outputs).toEqual({
      web_service_name: { value: "yaffle-web" },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("does not wait for usability when waitFor only needs outputs", async () => {
    const fetchMock = mockWorkspaceDetails({
      status: "activating",
      outputs: {},
    })
    const client = new YaffleClient({
      apiUrl: "https://yaffle.test",
      auth,
      logger,
    })

    const result = await client.getOutputs({
      org: "yaffle-dot-dev",
      repo: "yaffle",
      target: { type: "env", name: "main" },
      workspace: "apps/web/infra",
      waitFor: "outputs",
    })

    expect(result.status).toBe("activating")
    expect(result.outputs).toEqual({})
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

function mockWorkspaceDetails(options: {
  status: string
  outputs: Record<string, unknown> | null
}) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      data: {
        workspaces: [
          {
            preview: {
              id: "preview-1",
              workspacePath: "apps/web/infra",
              status: options.status,
              connectionStatus: "ready",
              missingProviders: [],
              conflictProviders: [],
              matchedConnections: [],
              blockedReason: null,
              stateKey: "main/apps/web/infra.tfstate",
              mode: "managed",
              requireApproval: false,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
            runs: [
              {
                id: "run-1",
                previewId: "preview-1",
                runGroupId: "run-group-1",
                runType: "apply",
                status: "success",
                checkRunId: null,
                planSummary: null,
                outputs: options.outputs,
                errorMessage: null,
                startedAt: "2026-01-01T00:00:00.000Z",
                completedAt: "2026-01-01T00:00:01.000Z",
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            ],
            outputs: options.outputs,
          },
        ],
      },
    }),
  )
}
