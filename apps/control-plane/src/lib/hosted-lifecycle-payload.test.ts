import { expect, test } from "@yaffle/test"

import { buildHostedLifecyclePayload } from "./hosted-lifecycle-payload.ts"

test("buildHostedLifecyclePayload includes git_base_sha when present", () => {
  expect(buildHostedLifecyclePayload({
    canonicalRepoNamespace: "test-org--fixture",
    environmentName: "pr-7",
    workspacePath: "apps/control-plane/infra",
    itemKey: "control-plane",
    phase: "activation",
    outputs: {},
    headSha: "head-sha",
    branch: "feature/base-sha",
    baseSha: "base-sha",
  })).toMatchObject({
    repo_namespace: "test-org--fixture",
    environment: "pr-7",
    workspace_path: "apps/control-plane/infra",
    item_key: "control-plane",
    phase: "activation",
    git_sha: "head-sha",
    git_branch: "feature/base-sha",
    git_base_sha: "base-sha",
  })
})

test("buildHostedLifecyclePayload omits git_base_sha when absent", () => {
  const payload = buildHostedLifecyclePayload({
    canonicalRepoNamespace: "test-org--fixture",
    environmentName: "main",
    workspacePath: "apps/control-plane/infra",
    itemKey: "control-plane",
    phase: "verification",
    outputs: {},
    headSha: "head-sha",
    branch: "main",
  })

  expect(payload).not.toHaveProperty("git_base_sha")
})
