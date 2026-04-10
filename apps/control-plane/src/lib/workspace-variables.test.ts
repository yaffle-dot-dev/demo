import { describe, expect, test } from "bun:test"

import { parseYaffleToml } from "./config-toml.ts"
import { buildWorkspaceVariablesByPath } from "./workspace-variables.ts"

describe("buildWorkspaceVariablesByPath", () => {
  test("renders workspace variables using webhook context", () => {
    const config = parseYaffleToml(`
version = 1

[[environments]]
name = "production"

[[workspaces]]
path = "apps/web/infra"
environments = ["production"]
variables.registry_host = "{{ environment }}.yaffle.dev"
variables.workspace = "{{ workspace_path }}"

[[workspaces]]
path = "apps/docs/infra"
environments = ["production"]
`)

    const variables = buildWorkspaceVariablesByPath(
      config,
      ["apps/web/infra", "apps/docs/infra"],
      {
        kind: "push",
        owner: "yaffle-dot-dev",
        repo: "yaffle",
        ref: "refs/heads/main",
        refType: "branch",
        refName: "main",
        headSha: "abc123",
        installationId: 123,
        repoGithubId: 456,
        ownerGithubId: 789,
        pusherGithubId: 321,
        pusherLogin: "alex",
        defaultBranch: "main",
      },
      "production",
      "named",
    )

    expect(variables).toEqual({
      "apps/web/infra": {
        registry_host: "production.yaffle.dev",
        workspace: "apps/web/infra",
      },
    })
  })
})
