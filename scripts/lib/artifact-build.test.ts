import { describe, expect, test } from "@yaffle/test"

import { shouldSkipArtifactBuild } from "./artifact-build"

describe("shouldSkipArtifactBuild", () => {
  test("does not skip direct invocations without an artifact plan", () => {
    expect(shouldSkipArtifactBuild()).toBe(false)
  })

  test("does not skip when CI needs to build a missing artifact", () => {
    expect(shouldSkipArtifactBuild({
      strategy: "build_missing_artifact",
      deployableName: "control-plane",
      changed: true,
      targetSha: "abc123",
      artifactRef: "repo/control-plane:sha-abc123",
    })).toBe(false)
  })

  test("skips when CI can reuse an existing artifact", () => {
    expect(shouldSkipArtifactBuild({
      strategy: "reuse_previous_artifact",
      deployableName: "control-plane",
      changed: false,
      targetSha: "abc123",
      artifactRef: "repo/control-plane:sha-prev",
      reusedFromArtifactRef: "repo/control-plane:sha-prev",
    })).toBe(true)
  })

  test("skips when the target sha artifact already exists", () => {
    expect(shouldSkipArtifactBuild({
      strategy: "use_sha_artifact",
      deployableName: "control-plane",
      changed: true,
      targetSha: "abc123",
      artifactRef: "repo/control-plane:sha-abc123",
    })).toBe(true)
  })
})
