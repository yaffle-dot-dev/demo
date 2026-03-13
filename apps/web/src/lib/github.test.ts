import { describe, expect, test } from "bun:test"

import {
  githubRepoUrl,
  githubTreeUrl,
  githubCommitUrl,
  githubPullUrl,
} from "./github"

describe("github URL utilities", () => {
  const params = { org: "yaffle-dot-dev", repo: "yaffle" }

  describe("githubRepoUrl", () => {
    test("builds correct repo URL with org and repo", () => {
      expect(githubRepoUrl(params)).toBe(
        "https://github.com/yaffle-dot-dev/yaffle",
      )
    })

    test("handles org with hyphens", () => {
      expect(githubRepoUrl({ org: "my-cool-org", repo: "my-repo" })).toBe(
        "https://github.com/my-cool-org/my-repo",
      )
    })
  })

  describe("githubTreeUrl", () => {
    test("builds correct tree URL for branch", () => {
      expect(githubTreeUrl(params, "main")).toBe(
        "https://github.com/yaffle-dot-dev/yaffle/tree/main",
      )
    })

    test("handles branch with slashes", () => {
      expect(githubTreeUrl(params, "feature/add-auth")).toBe(
        "https://github.com/yaffle-dot-dev/yaffle/tree/feature/add-auth",
      )
    })
  })

  describe("githubCommitUrl", () => {
    test("builds correct commit URL", () => {
      const sha = "abc123def456"
      expect(githubCommitUrl(params, sha)).toBe(
        "https://github.com/yaffle-dot-dev/yaffle/commit/abc123def456",
      )
    })

    test("handles full SHA", () => {
      const fullSha = "abc123def456789012345678901234567890abcd"
      expect(githubCommitUrl(params, fullSha)).toBe(
        `https://github.com/yaffle-dot-dev/yaffle/commit/${fullSha}`,
      )
    })
  })

  describe("githubPullUrl", () => {
    test("builds correct PR URL", () => {
      expect(githubPullUrl(params, 42)).toBe(
        "https://github.com/yaffle-dot-dev/yaffle/pull/42",
      )
    })
  })
})
