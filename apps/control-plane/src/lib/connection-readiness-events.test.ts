import { describe, expect, test } from "@yaffle/test"

import { emitConnectionReadinessChangedForOrg } from "./connection-readiness-events.ts"

describe("emitConnectionReadinessChangedForOrg", () => {
  test("emits deployment updates for each latest deployment in the org", async () => {
    const emitted: Array<{
      deploymentId: string
      orgId: string
      repo: string
      environmentKind: string
      environmentName: string
    }> = []

    const count = await emitConnectionReadinessChangedForOrg("org-123", {
      listLatestDeploymentsForOrg: async (orgId) => {
        expect(orgId).toBe("org-123")

        return [
          {
            id: "dep-1",
            orgId,
            repo: "acme/infrastructure",
            environmentKind: "named",
            environmentName: "main",
          },
          {
            id: "dep-2",
            orgId,
            repo: "acme/infrastructure",
            environmentKind: "transient",
            environmentName: "pr-42",
          },
        ] as never
      },
      emitDeploymentUpdate: (deploymentId, emittedOrgId, repo, environmentKind, environmentName) => {
        emitted.push({
          deploymentId,
          orgId: emittedOrgId,
          repo,
          environmentKind,
          environmentName,
        })
      },
    })

    expect(count).toBe(2)
    expect(emitted).toEqual([
      {
        deploymentId: "dep-1",
        orgId: "org-123",
        repo: "acme/infrastructure",
        environmentKind: "named",
        environmentName: "main",
      },
      {
        deploymentId: "dep-2",
        orgId: "org-123",
        repo: "acme/infrastructure",
        environmentKind: "transient",
        environmentName: "pr-42",
      },
    ])
  })
})
