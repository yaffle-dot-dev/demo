import { describe, expect, test } from "@yaffle/test"

import { chooseArtifactStrategy } from "./artifact-resolution"

describe("chooseArtifactStrategy", () => {
  test("uses sha artifact when it exists", () => {
    expect(chooseArtifactStrategy({
      deployableName: "control-plane",
      targetSha: "abc123",
      artifactRef: "repo/control-plane:sha-abc123",
      artifactExists: true,
      changed: true,
      currentArtifactRef: "repo/control-plane:sha-old",
    })).toEqual({
      strategy: "use_sha_artifact",
      deployableName: "control-plane",
      changed: true,
      targetSha: "abc123",
      artifactRef: "repo/control-plane:sha-abc123",
    })
  })

  test("reuses previous artifact when unchanged and missing target image", () => {
    expect(chooseArtifactStrategy({
      deployableName: "web",
      targetSha: "abc123",
      artifactRef: "repo/web:sha-abc123",
      artifactExists: false,
      changed: false,
      currentArtifactRef: "repo/web:sha-prev",
    })).toEqual({
      strategy: "reuse_previous_artifact",
      deployableName: "web",
      changed: false,
      targetSha: "abc123",
      artifactRef: "repo/web:sha-prev",
      reusedFromArtifactRef: "repo/web:sha-prev",
    })
  })

  test("falls back to build when changed and artifact is missing", () => {
    expect(chooseArtifactStrategy({
      deployableName: "runner",
      targetSha: "abc123",
      artifactRef: "repo/runner:sha-abc123",
      artifactExists: false,
      changed: true,
      currentArtifactRef: "repo/runner:sha-prev",
    })).toEqual({
      strategy: "build_missing_artifact",
      deployableName: "runner",
      changed: true,
      targetSha: "abc123",
      artifactRef: "repo/runner:sha-abc123",
    })
  })
})
