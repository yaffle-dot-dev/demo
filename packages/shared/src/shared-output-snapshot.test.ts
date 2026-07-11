import { readFileSync } from "node:fs"

import { describe, expect, test } from "@yaffle/test"

import {
  environmentName,
  publicationVersion,
  stateSerial,
  stateVersionIdentity,
  type SharedOutputSnapshotV1,
} from "./shared-output-snapshot"

const expectedSnapshot = {
  contractVersion: 1,
  snapshotId: "sos_01JZXNS2Q6MEW4NZ4M9T8J2R7K",
  publicationVersion: publicationVersion(7),
  producer: {
    organizationId: "org_01JZXNQ4DXQ3Z3JSYJ1K98BH7V",
    organization: "acme",
    repositoryId: "repo_01JZXNR3HVCYH0X7PMSB9T3F6A",
    repository: "platform",
    workspace: "infra/shared",
    environment: {
      class: "transient_managed",
      name: environmentName("review-42"),
    },
  },
  sourceRevision: {
    vcs: "git",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    ref: "refs/heads/main",
  },
  state: {
    identity: stateVersionIdentity("statev_01JZXNT7PND73G9ESQZT15E0H8"),
    serial: stateSerial(42),
  },
  publishedAt: "2026-07-10T12:00:00Z",
  values: {
    apiUrl: { value: "https://api.example.com", sensitive: false },
    databasePassword: { value: null, sensitive: true },
  },
} satisfies SharedOutputSnapshotV1

describe("SharedOutputSnapshotV1", () => {
  test("accepts source-neutral environment names", () => {
    expect(environmentName("review-42")).toBe("review-42")
    expect(environmentName("pr-42")).toBe("pr-42")
    expect(() => environmentName(" ")).toThrow("Environment name must not be empty")
  })

  test("builds only positive publication versions", () => {
    expect(publicationVersion(7)).toBe(7)
    expect(() => publicationVersion(0)).toThrow(
      "Publication version must be a positive safe integer",
    )
  })

  test("builds only opaque state identities with safe serials", () => {
    expect(stateVersionIdentity("statev_01JZXNT7PND73G9ESQZT15E0H8")).toBe(
      "statev_01JZXNT7PND73G9ESQZT15E0H8",
    )
    expect(() => stateVersionIdentity("s3://state-bucket/key")).toThrow(
      "State identity must be an opaque statev_ identifier",
    )
    expect(stateSerial(0)).toBe(0)
    expect(() => stateSerial(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      "State serial must be a non-negative safe integer",
    )
  })

  test("matches the cross-language wire fixture", () => {
    const fixture: unknown = JSON.parse(
      readFileSync(
        new URL("../../../testdata/contracts/shared-output-snapshot-v1.json", import.meta.url),
        "utf8",
      ),
    )

    expect(fixture).toEqual(expectedSnapshot)
  })
})
