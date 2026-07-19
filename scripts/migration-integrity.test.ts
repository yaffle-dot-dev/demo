import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { describe, expect, test } from "@yaffle/test"

const PUBLISHED_MIGRATION_HASHES = {
  "0030_workspace_environment_identity.sql":
    "7fd8efa3a289931c5e0ebb2a29a5d259b8db7dfb4f2351213fe8f9c059f8495c",
  "0031_automatic_isolation_scan_preflight.sql":
    "4adfdb75913c7886f2368db373d126a5be2537c4655a5c014cbe9261d917bc1f",
  "0032_immutable_execution_snapshot.sql":
    "eac021a46aba36e290e3591a8b386bc1a326c196cc02e3f53998a827bb405728",
  "0033_repair_execution_snapshot_schema.sql":
    "443eb4fc0ebd146bb3acdd9d9c95b308746a76f9d1e1018d7e3875ea13593bea",
} as const

describe("published migration integrity", () => {
  test.each(Object.entries(PUBLISHED_MIGRATION_HASHES))(
    "does not rewrite %s",
    async (filename, expectedHash) => {
      const migration = await readFile(
        resolve(process.cwd(), "apps/control-plane/drizzle", filename),
      )
      expect(createHash("sha256").update(migration).digest("hex")).toBe(expectedHash)
    },
  )
})
