import { describe, expect, test } from "@yaffle/test"

import { isAncestorCommit, listChangedFiles } from "./git"

describe("listChangedFiles", () => {
  test("includes deleted files when comparing artifact lineage", async () => {
    let command: string[] | undefined
    const files = await listChangedFiles("deployed-sha", "target-sha", async (args) => {
      command = args
      return "apps/control-plane/src/deleted.ts\n"
    })

    expect(command).toEqual([
      "git",
      "diff",
      "--name-only",
      "--no-renames",
      "deployed-sha",
      "target-sha",
    ])
    expect(files).toEqual(["apps/control-plane/src/deleted.ts"])
  })

  test("checks artifact ancestry before allowing reuse", async () => {
    let command: string[] | undefined
    const isAncestor = await isAncestorCommit("deployed-sha", "target-sha", async (args) => {
      command = args
      return ""
    })

    expect(command).toEqual(["git", "merge-base", "--is-ancestor", "deployed-sha", "target-sha"])
    expect(isAncestor).toBe(true)
  })

  test("rejects unavailable or unrelated artifact lineage", async () => {
    await expect(
      isAncestorCommit("deployed-sha", "target-sha", async () => {
        throw new Error("not an ancestor")
      }),
    ).resolves.toBe(false)
  })
})
