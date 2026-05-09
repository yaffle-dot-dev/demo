import { afterEach, expect, test } from "@yaffle/test"
import { access, readFile } from "node:fs/promises"
import { constants as fsConstants } from "node:fs"

import { defineDeployable } from "./deployables/types"
import { checkDeployableSecrets, withDeployablePhaseSecrets } from "./secrets"

const TEST_TARGET = {
  environment: {
    kind: "named" as const,
    name: "main",
  },
  git: {
    sha: "testsha",
  },
  source: {
    kind: "manual" as const,
    event: "manual",
  },
}

afterEach(() => {
  delete process.env.TEST_SECRET_VALUE
  delete process.env.TEST_SECRET_FILE_PATH
  delete process.env.SECRET_SOURCE_ENV
})

test("injects env-delivered secrets for a phase and restores environment", async () => {
  process.env.SECRET_SOURCE_ENV = "resolved-secret"

  const deployable = defineDeployable({
    name: "test-deployable",
    root: "apps/test",
    supports: {
      environmentKinds: ["named"],
    },
    workspaces: ["apps/test/infra"],
    watchedPaths: ["apps/test/"],
    secrets: [
      {
        name: "test-secret",
        phase: "build",
        access: "value",
        source: {
          type: "env",
          name: "SECRET_SOURCE_ENV",
        },
        delivery: {
          type: "env",
          name: "TEST_SECRET_VALUE",
        },
      },
    ],
    build: async () => {},
    deploy: async () => {},
  })

  expect(process.env.TEST_SECRET_VALUE).toBeUndefined()

  await withDeployablePhaseSecrets({
    deployable,
    phase: "build",
    target: TEST_TARGET,
    fn: async () => {
      expect(process.env.TEST_SECRET_VALUE).toBe("resolved-secret")
    },
  })

  expect(process.env.TEST_SECRET_VALUE).toBeUndefined()
})

test("writes file-delivered secrets and cleans them up", async () => {
  const deployable = defineDeployable({
    name: "file-secret-deployable",
    root: "apps/test",
    supports: {
      environmentKinds: ["named"],
    },
    workspaces: ["apps/test/infra"],
    watchedPaths: ["apps/test/"],
    secrets: [
      {
        name: "npmrc",
        phase: "build",
        access: "value",
        source: {
          type: "literal",
          value: "registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=test-token\n",
        },
        delivery: {
          type: "file",
          pathEnvVar: "TEST_SECRET_FILE_PATH",
          fileName: ".npmrc",
        },
      },
    ],
    build: async () => {},
    deploy: async () => {},
  })

  let capturedPath = ""

  await withDeployablePhaseSecrets({
    deployable,
    phase: "build",
    target: TEST_TARGET,
    fn: async () => {
      capturedPath = process.env.TEST_SECRET_FILE_PATH || ""
      expect(capturedPath.endsWith(".npmrc")).toBe(true)

      const content = await readFile(capturedPath, "utf8")
      expect(content.includes("_authToken=test-token")).toBe(true)
    },
  })

  expect(process.env.TEST_SECRET_FILE_PATH).toBeUndefined()
  await expect(access(capturedPath, fsConstants.F_OK)).rejects.toThrow()
})

test("reports secret check status for required and optional secrets", async () => {
  const deployable = defineDeployable({
    name: "check-deployable",
    root: "apps/test",
    supports: {
      environmentKinds: ["named"],
    },
    workspaces: ["apps/test/infra"],
    watchedPaths: ["apps/test/"],
    secrets: [
      {
        name: "required-secret",
        phase: "deploy",
        access: "value",
        source: {
          type: "env",
          name: "SECRET_SOURCE_ENV",
        },
        delivery: {
          type: "env",
          name: "TEST_SECRET_VALUE",
        },
      },
      {
        name: "optional-secret",
        phase: "deploy",
        access: "value",
        source: {
          type: "env",
          name: "MISSING_OPTIONAL_SECRET",
        },
        delivery: {
          type: "env",
          name: "OPTIONAL_SECRET_VALUE",
        },
        optional: true,
      },
    ],
    build: async () => {},
    deploy: async () => {},
  })

  process.env.SECRET_SOURCE_ENV = "resolved-secret"

  const checks = await checkDeployableSecrets({
    deployables: [deployable],
    target: TEST_TARGET,
  })

  expect(checks).toHaveLength(2)
  expect(checks.find((entry) => entry.secret === "required-secret")?.status).toBe("ok")
  expect(checks.find((entry) => entry.secret === "optional-secret")?.status).toBe("optional_missing")
})

test("treats placeholder secret values as missing", async () => {
  process.env.SECRET_SOURCE_ENV = "PLACEHOLDER-set-via-cli"

  const deployable = defineDeployable({
    name: "placeholder-check-deployable",
    root: "apps/test",
    supports: {
      environmentKinds: ["named"],
    },
    workspaces: ["apps/test/infra"],
    watchedPaths: ["apps/test/"],
    secrets: [
      {
        name: "placeholder-secret",
        phase: "deploy",
        access: "value",
        source: {
          type: "env",
          name: "SECRET_SOURCE_ENV",
        },
        delivery: {
          type: "env",
          name: "TEST_SECRET_VALUE",
        },
      },
    ],
    build: async () => {},
    deploy: async () => {},
  })

  const checks = await checkDeployableSecrets({
    deployables: [deployable],
    target: TEST_TARGET,
  })

  expect(checks[0]?.status).toBe("missing")
})
