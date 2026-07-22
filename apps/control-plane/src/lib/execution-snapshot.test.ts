import { describe, expect, test } from "@yaffle/test"

import type { PullRequestContext } from "@yaffle/shared"

import type { YaffleTomlConfig } from "./config-toml.ts"
import {
  buildExecutionSnapshot,
  buildExecutionVariables,
  buildMergeImpactVariables,
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
        outputs: {
          endpoint: { visibility: "internal" },
        },
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
      {
        path: "infra/shared",
        environments: ["main"],
        automaticPreviewIsolation: false,
        variables: {},
        outputs: { network_id: { visibility: "internal" } },
        activation: [],
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
      outputs: {
        endpoint: { visibility: "internal" },
      },
    })
    expect(snapshot.managedOutputProducers).toEqual([
      { path: "infra/shared", environmentNames: ["main"] },
    ])
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
    mutableConfig.workspaces[0].outputs!.endpoint.visibility = "public"
    mutableConfig.workspaces[0].outputs!.endpoint.consumers = ["other:repo:infra"]

    expect(findExecutionSnapshotWorkspace(snapshot, "infra")).toMatchObject({
      approval: { approvers: ["github:user:reviewer"] },
      lifecycle: {
        activation: [{ request: { url: "https://deploy.example.test" } }],
      },
      outputs: { endpoint: { visibility: "internal" } },
    })
  })

  test("carries an immutable named target for merge-impact planning", () => {
    const snapshot = buildExecutionSnapshot({
      ctx: context,
      config: config(),
      workspacePaths: ["infra"],
      workspaceVariables: { infra: { release: "preview-value" } },
      environmentKind: "transient",
      environmentName: "pr-42",
      mergeImpact: {
        environmentName: "production",
        ref: "refs/heads/main",
        configurationRevision: "base-sha",
        configurationDigest: "base-config-digest",
        workspacePaths: ["infra"],
        workspaceVariables: { infra: { release: "production-value" } },
      },
    })

    expect(snapshot.mergeImpact).toEqual({
      environmentName: "production",
      ref: "refs/heads/main",
      configurationRevision: "base-sha",
      configurationDigest: "base-config-digest",
      workspaces: [{ path: "infra", variables: { release: "production-value" } }],
    })
    expect(buildMergeImpactVariables(snapshot, "infra")).toEqual({
      environment: "production",
      environment_kind: "named",
      release: "production-value",
    })
  })

  test.each([
    "https://deploy.example.test?token=do-not-persist",
    "https://deploy.example.test?sig=do-not-persist",
    "https://deploy.example.test?code=do-not-persist",
    "https://user:password@deploy.example.test",
  ])("rejects lifecycle credentials embedded in request URL %s", (url) => {
    const unsafeConfig = config()
    unsafeConfig.workspaces[0].activation![0].request!.url = url

    expect(() =>
      buildExecutionSnapshot({
        ctx: context,
        config: unsafeConfig,
        workspacePaths: ["infra"],
        workspaceVariables: { infra: {} },
        environmentKind: "transient",
        environmentName: "pr-42",
      }),
    ).toThrow("must use a connection instead of URL credentials")
  })

  test("rejects credentials embedded in a GitHub API URL", () => {
    const unsafeConfig = config()
    const hook = unsafeConfig.workspaces[0].activation![0]
    hook.request = undefined
    hook.github = {
      event_type: "deploy",
      api_url: "https://api.github.test?sig=do-not-persist",
    }

    expect(() =>
      buildExecutionSnapshot({
        ctx: context,
        config: unsafeConfig,
        workspacePaths: ["infra"],
        workspaceVariables: { infra: {} },
        environmentKind: "transient",
        environmentName: "pr-42",
      }),
    ).toThrow("must use a connection instead of URL credentials")
  })
})
