import { afterEach, describe, expect, test } from "@yaffle/test"

import {
  PROVIDER_DISCOVERY_REQUEUE_COOLDOWN_MS,
  queueUnknownProviderDiscovery,
} from "./provider-discovery.ts"

const originalDiscoveryEnabled = process.env.YAFFLE_PROVIDER_DISCOVERY_ENABLED

function makeRequirement(providerType: string, providerSource?: string): {
  providerType: string
  providerSource: string | null
} {
  return {
    providerType,
    providerSource: providerSource ?? null,
  }
}

afterEach(() => {
  if (originalDiscoveryEnabled === undefined) {
    delete process.env.YAFFLE_PROVIDER_DISCOVERY_ENABLED
  } else {
    process.env.YAFFLE_PROVIDER_DISCOVERY_ENABLED = originalDiscoveryEnabled
  }
})

describe("queueUnknownProviderDiscovery", () => {
  test("skips requeueing when a recent completed discovery exists", async () => {
    process.env.YAFFLE_PROVIDER_DISCOVERY_ENABLED = "true"

    const createdJobs: Array<{ payload: Record<string, unknown> }> = []
    const recentLookups: Array<{
      orgId: string
      providerType: string
      providerSource?: string
      since: Date
    }> = []
    const now = new Date("2026-04-22T02:00:00.000Z")

    await queueUnknownProviderDiscovery(
      {
        orgId: "org-123",
        providers: [makeRequirement("hookdeck", "hookdeck/hookdeck")],
        repo: "yaffle",
        environment: "main",
        workspacePath: "infra/shared",
      },
      {
        createJob: async (data) => {
          createdJobs.push({ payload: data.payload })
          return {} as never
        },
        findActiveProviderDiscoveryJob: async () => undefined,
        findProviderCredentialSignatureByType: async () => undefined,
        findRecentCompletedProviderDiscoveryJob: async (params) => {
          recentLookups.push(params)
          return {
            id: "recent-job",
            status: "completed",
            createdAt: new Date(now.getTime() - 60_000),
          } as never
        },
        listActiveProviderCredentialSignatures: async () => [],
        now: () => now,
      },
    )

    expect(createdJobs).toHaveLength(0)
    expect(recentLookups).toEqual([
      {
        orgId: "org-123",
        providerType: "hookdeck",
        providerSource: "hookdeck/hookdeck",
        since: new Date(now.getTime() - PROVIDER_DISCOVERY_REQUEUE_COOLDOWN_MS),
      },
    ])
  })

  test("creates a job when there is no recent completed discovery", async () => {
    process.env.YAFFLE_PROVIDER_DISCOVERY_ENABLED = "true"

    const createdJobs: Array<{ payload: Record<string, unknown> }> = []

    await queueUnknownProviderDiscovery(
      {
        orgId: "org-123",
        providers: [makeRequirement("hookdeck", "hookdeck/hookdeck")],
        repo: "yaffle",
        environment: "main",
        workspacePath: "infra/shared",
      },
      {
        createJob: async (data) => {
          createdJobs.push({ payload: data.payload })
          return {} as never
        },
        findActiveProviderDiscoveryJob: async () => undefined,
        findProviderCredentialSignatureByType: async () => undefined,
        findRecentCompletedProviderDiscoveryJob: async () => undefined,
        listActiveProviderCredentialSignatures: async () => [],
        now: () => new Date("2026-04-22T02:00:00.000Z"),
      },
    )

    expect(createdJobs).toHaveLength(1)
    expect(createdJobs[0]?.payload).toMatchObject({
      providerType: "hookdeck",
      providerSource: "hookdeck/hookdeck",
      repo: "yaffle",
      environment: "main",
      workspacePath: "infra/shared",
      requestedByOrgId: "org-123",
    })
  })
})
