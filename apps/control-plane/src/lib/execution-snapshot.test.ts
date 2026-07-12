import { describe, expect, test } from "@yaffle/test"

import type { PullRequestContext } from "@yaffle/shared"

import type { YaffleTomlConfig } from "./config-toml.ts"
import {
  buildExecutionSnapshot,
  buildExecutionVariables,
  findExecutionSnapshotWorkspace,
} from "./execution-snapshot.ts"

const context: PullRequestContext = {
  kind: "pull_request",
  installationId: 123,
  repoGithubId: 456,
  ownerGithubId: 789,
  owner: "acme",
  repo: "infra",
  prNumber: 42,
  action: "opened",
  headSha: "commit-sha",
  baseSha: "base-sha",
  branch: "feature/snapshot",
  authorGithubId: 987,
  authorLogin: "builder",
  merged: false,
  defaultBranch: "main",
}

function config(): YaffleTomlConfig {
  return {
    version: 1,
    environments: [{ name: "main" }],
    workspaces: [
      {
        path: "infra",
        environments: "*",
        automaticPreviewIsolation: true,
        variables: { release: "source-template" },
        activation: [
          {
            key: "deploy",
            environments: ["*"],
            kind: "generic",
            failure: "failed",
            scopes: [],
            request: { url: "https://deploy.example.test", method: "POST" },
          },
        ],
        verification: [],
      },
    ],
    cloud: {
      triggers: {},
      approvals: [
        {
          workspaces: ["infra"],
          environments: ["*"],
          approvers: ["github:user:reviewer"],
        },
      ],
    },
  }
}

describe("execution snapshot", () => {
  test("carries resolved variables, approval, and lifecycle into execution", () => {
    const snapshot = buildExecutionSnapshot({
      ctx: context,
      config: config(),
      workspacePaths: ["infra"],
      workspaceVariables: { infra: { release: "resolved-value" } },
      environmentKind: "transient",
      environmentName: "pr-42",
    })

    expect(buildExecutionVariables(snapshot, "infra")).toEqual({
      environment: "pr-42",
      environment_kind: "transient",
      release: "resolved-value",
    })
    expect(findExecutionSnapshotWorkspace(snapshot, "infra")).toMatchObject({
      approval: {
        required: true,
        approvers: ["github:user:reviewer"],
      },
      lifecycle: {
        activation: [
          {
            key: "deploy",
            request: { url: "https://deploy.example.test" },
          },
        ],
        verification: [],
      },
    })
  })

  test("does not retain mutable references to repository configuration", () => {
    const mutableConfig = config()
    const snapshot = buildExecutionSnapshot({
      ctx: context,
      config: mutableConfig,
      workspacePaths: ["infra"],
      workspaceVariables: { infra: { release: "first" } },
      environmentKind: "transient",
      environmentName: "pr-42",
    })

    mutableConfig.workspaces[0].activation![0].request!.url = "https://changed.example.test"
    mutableConfig.cloud.approvals[0].approvers[0] = "github:user:changed"

    expect(findExecutionSnapshotWorkspace(snapshot, "infra")).toMatchObject({
      approval: { approvers: ["github:user:reviewer"] },
      lifecycle: {
        activation: [{ request: { url: "https://deploy.example.test" } }],
      },
    })
  })
})
