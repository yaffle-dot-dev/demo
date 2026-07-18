import { describe, expect, test } from "@yaffle/test"

import {
  chooseArtifactStrategy,
  hasDeployableChangedSinceArtifact,
  resolveCurrentArtifactRefOrNull,
  resolveReusableCurrentArtifactRef,
} from "./artifact-resolution"

const CONTROL_PLANE_WATCHED_PATHS = ["apps/control-plane/", "packages/shared/"]

describe("chooseArtifactStrategy", () => {
  test("uses sha artifact when it exists", () => {
    expect(
      chooseArtifactStrategy({
        deployableName: "control-plane",
        targetSha: "abc123",
        artifactRef: "repo/control-plane:sha-abc123",
        artifactExists: true,
        changed: true,
        currentArtifactRef: "repo/control-plane:sha-old",
      }),
    ).toEqual({
      strategy: "use_sha_artifact",
      deployableName: "control-plane",
      changed: true,
      targetSha: "abc123",
      artifactRef: "repo/control-plane:sha-abc123",
    })
  })

  test("reuses previous artifact when unchanged and missing target image", () => {
    expect(
      chooseArtifactStrategy({
        deployableName: "web",
        targetSha: "abc123",
        artifactRef: "repo/web:sha-abc123",
        artifactExists: false,
        changed: false,
        currentArtifactRef: "repo/web:sha-prev",
      }),
    ).toEqual({
      strategy: "reuse_previous_artifact",
      deployableName: "web",
      changed: false,
      targetSha: "abc123",
      artifactRef: "repo/web:sha-prev",
      reusedFromArtifactRef: "repo/web:sha-prev",
    })
  })

  test("falls back to build when changed and artifact is missing", () => {
    expect(
      chooseArtifactStrategy({
        deployableName: "runner",
        targetSha: "abc123",
        artifactRef: "repo/runner:sha-abc123",
        artifactExists: false,
        changed: true,
        currentArtifactRef: "repo/runner:sha-prev",
      }),
    ).toEqual({
      strategy: "build_missing_artifact",
      deployableName: "runner",
      changed: true,
      targetSha: "abc123",
      artifactRef: "repo/runner:sha-abc123",
    })
  })
})

describe("hasDeployableChangedSinceArtifact", () => {
  test("rebuilds from the deployed image after an earlier activation failed", async () => {
    const deployedSha = "b086c2053fa5cc4251e8ecd11de03c61bc9c89f5"
    const targetSha = "9a7f4c4aec4fdff097f746f0d3599db28c6ea067"
    let comparedRevisions: [string, string] | undefined

    const changed = await hasDeployableChangedSinceArtifact({
      watchedPaths: CONTROL_PLANE_WATCHED_PATHS,
      targetSha,
      currentArtifactRef: `repo/control-plane:sha-${deployedSha}`,
      isAncestor: async () => true,
      listChangedFiles: async (baseSha, headSha) => {
        comparedRevisions = [baseSha, headSha]
        return ["apps/control-plane/src/lib/execution-snapshot.ts", "scripts/db-migrate.ts"]
      },
    })

    expect(comparedRevisions).toEqual([deployedSha, targetSha])
    expect(
      chooseArtifactStrategy({
        deployableName: "control-plane",
        targetSha,
        artifactRef: `repo/control-plane:sha-${targetSha}`,
        artifactExists: false,
        changed,
        currentArtifactRef: `repo/control-plane:sha-${deployedSha}`,
      }).strategy,
    ).toBe("build_missing_artifact")
  })

  test("reuses an ancestor artifact when only unwatched files changed", async () => {
    const changed = await hasDeployableChangedSinceArtifact({
      watchedPaths: CONTROL_PLANE_WATCHED_PATHS,
      targetSha: "9a7f4c4aec4fdff097f746f0d3599db28c6ea067",
      currentArtifactRef: "repo/control-plane:sha-b086c2053fa5cc4251e8ecd11de03c61bc9c89f5",
      isAncestor: async () => true,
      listChangedFiles: async () => ["scripts/db-migrate.ts"],
    })

    expect(changed).toBe(false)
  })

  test("rebuilds when the deployed artifact is not an ancestor of the target", async () => {
    const changed = await hasDeployableChangedSinceArtifact({
      watchedPaths: CONTROL_PLANE_WATCHED_PATHS,
      targetSha: "9a7f4c4aec4fdff097f746f0d3599db28c6ea067",
      currentArtifactRef: "repo/control-plane:sha-b086c2053fa5cc4251e8ecd11de03c61bc9c89f5",
      isAncestor: async () => false,
      listChangedFiles: async () => [],
    })

    expect(changed).toBe(true)
  })

  test("rebuilds when deployed artifact lineage is unavailable", async () => {
    await expect(
      hasDeployableChangedSinceArtifact({
        watchedPaths: CONTROL_PLANE_WATCHED_PATHS,
        targetSha: "9a7f4c4aec4fdff097f746f0d3599db28c6ea067",
        currentArtifactRef: "repo/control-plane:latest",
      }),
    ).resolves.toBe(true)
  })
})

describe("resolveCurrentArtifactRefOrNull", () => {
  test("falls back to rebuilding when the current artifact cannot be read", async () => {
    await expect(
      resolveCurrentArtifactRefOrNull(async () => {
        throw new Error("ECS unavailable")
      }),
    ).resolves.toBeNull()
  })
})

describe("resolveReusableCurrentArtifactRef", () => {
  test("rebuilds when ECS references an image tag that no longer exists", async () => {
    const currentArtifactRef = "repo/control-plane:sha-b086c2053fa5cc4251e8ecd11de03c61bc9c89f5"
    const reusableArtifactRef = await resolveReusableCurrentArtifactRef({
      currentArtifactRef,
      shouldPush: true,
      region: "us-east-1",
      imageTagExists: async () => false,
    })

    expect(reusableArtifactRef).toBeNull()
    expect(
      chooseArtifactStrategy({
        deployableName: "control-plane",
        targetSha: "b086c2053fa5cc4251e8ecd11de03c61bc9c89f5",
        artifactRef: currentArtifactRef,
        artifactExists: false,
        changed: true,
        currentArtifactRef: reusableArtifactRef,
      }).strategy,
    ).toBe("build_missing_artifact")
  })
})
