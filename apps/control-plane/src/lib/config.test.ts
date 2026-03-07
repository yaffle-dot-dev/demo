import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  type VariableContext,
  type YaffleConfig,
  interpolateVariables,
  loadConfig,
  parseYaml,
  prVariableContext,
  pushVariableContext,
} from "./config.ts"

describe("parseYaml", () => {
  test("parses a minimal config", () => {
    const input = `
version: 1

workspaces:
  - path: infra
`
    const result = parseYaml(input) as YaffleConfig
    expect(result.version).toBe(1)
    expect(result.workspaces).toHaveLength(1)
    expect(result.workspaces[0].path).toBe("infra")
  })

  test("parses full config with all options", () => {
    const input = `
version: 1
default_branch: main

workspaces:
  - path: infra
    auto_apply: true
    auto_apply_on_merge: false
    require_approval: true
    approvers:
      - lamalex
    variables:
      environment: "{{ env }}"
      region: us-east-1
  - path: infra/monitoring
    auto_apply: false
    variables:
      environment: "{{ env }}"
`
    const result = parseYaml(input) as YaffleConfig
    expect(result.version).toBe(1)
    expect(result.default_branch).toBe("main")
    expect(result.workspaces).toHaveLength(2)

    expect(result.workspaces[0].path).toBe("infra")
    expect(result.workspaces[0].auto_apply).toBe(true)
    expect(result.workspaces[0].auto_apply_on_merge).toBe(false)
    expect(result.workspaces[0].require_approval).toBe(true)
    expect(result.workspaces[0].approvers).toEqual(["lamalex"])
    expect(result.workspaces[0].variables?.environment).toBe("{{ env }}")
    expect(result.workspaces[0].variables?.region).toBe("us-east-1")

    expect(result.workspaces[1].path).toBe("infra/monitoring")
    expect(result.workspaces[1].auto_apply).toBe(false)
    expect(result.workspaces[1].variables?.environment).toBe("{{ env }}")
  })

  test("handles comments and blank lines", () => {
    const input = `
# Yaffle config
version: 1

# Define workspaces
workspaces:
  # Main infra
  - path: infra
`
    const result = parseYaml(input) as YaffleConfig
    expect(result.version).toBe(1)
    expect(result.workspaces).toHaveLength(1)
  })

  test("parses boolean values correctly", () => {
    const input = `
version: 1
workspaces:
  - path: infra
    auto_apply: false
    auto_apply_on_merge: true
`
    const result = parseYaml(input) as YaffleConfig
    expect(result.workspaces[0].auto_apply).toBe(false)
    expect(result.workspaces[0].auto_apply_on_merge).toBe(true)
  })

  test("parses quoted strings", () => {
    const input = `
version: 1
workspaces:
  - path: "infra/my project"
    variables:
      env: '{{ env }}'
`
    const result = parseYaml(input) as YaffleConfig
    expect(result.workspaces[0].path).toBe("infra/my project")
    expect(result.workspaces[0].variables?.env).toBe("{{ env }}")
  })
})

describe("loadConfig", () => {
  test("loads and validates a config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yaffle-config-"))
    try {
      await mkdir(join(dir, ".yaffle"), { recursive: true })
      await writeFile(
        join(dir, ".yaffle/config.yml"),
        `version: 1\nworkspaces:\n  - path: infra\n`,
      )

      const config = await loadConfig(dir)
      expect(config.version).toBe(1)
      expect(config.workspaces).toHaveLength(1)
      expect(config.workspaces[0].path).toBe("infra")
      // Defaults applied by zod
      expect(config.workspaces[0].auto_apply).toBe(true)
      expect(config.workspaces[0].auto_apply_on_merge).toBe(true)
      expect(config.workspaces[0].require_approval).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("throws ConfigError when file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yaffle-config-"))
    try {
      await expect(loadConfig(dir)).rejects.toThrow("No .yaffle/config.yml found")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("throws ConfigError on invalid version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yaffle-config-"))
    try {
      await mkdir(join(dir, ".yaffle"), { recursive: true })
      await writeFile(
        join(dir, ".yaffle/config.yml"),
        `version: 2\nworkspaces:\n  - path: infra\n`,
      )

      await expect(loadConfig(dir)).rejects.toThrow("Invalid .yaffle/config.yml")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("throws ConfigError when workspaces is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yaffle-config-"))
    try {
      await mkdir(join(dir, ".yaffle"), { recursive: true })
      await writeFile(
        join(dir, ".yaffle/config.yml"),
        `version: 1\nworkspaces:\n`,
      )

      await expect(loadConfig(dir)).rejects.toThrow("Invalid .yaffle/config.yml")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("interpolateVariables", () => {
  const ctx: VariableContext = {
    env: "prvw-42",
    pr_number: "42",
    branch: "feature/test",
    sha: "abc123",
    owner: "lamalex",
    repo: "yaffle",
  }

  test("interpolates all known placeholders", () => {
    const vars = {
      environment: "{{ env }}",
      pr: "{{ pr_number }}",
      ref: "{{ branch }}",
      commit: "{{ sha }}",
      org: "{{ owner }}",
      repository: "{{ repo }}",
    }

    const result = interpolateVariables(vars, ctx)
    expect(result.environment).toBe("prvw-42")
    expect(result.pr).toBe("42")
    expect(result.ref).toBe("feature/test")
    expect(result.commit).toBe("abc123")
    expect(result.org).toBe("lamalex")
    expect(result.repository).toBe("yaffle")
  })

  test("passes through static values", () => {
    const vars = { region: "us-east-1", zone: "a" }
    const result = interpolateVariables(vars, ctx)
    expect(result.region).toBe("us-east-1")
    expect(result.zone).toBe("a")
  })

  test("mixes static and interpolated values", () => {
    const vars = {
      environment: "{{ env }}",
      region: "us-east-1",
    }
    const result = interpolateVariables(vars, ctx)
    expect(result.environment).toBe("prvw-42")
    expect(result.region).toBe("us-east-1")
  })

  test("handles whitespace variations in placeholders", () => {
    const vars = {
      a: "{{env}}",
      b: "{{ env }}",
      c: "{{  env  }}",
    }
    const result = interpolateVariables(vars, ctx)
    expect(result.a).toBe("prvw-42")
    expect(result.b).toBe("prvw-42")
    expect(result.c).toBe("prvw-42")
  })

  test("leaves unknown placeholders as-is", () => {
    const vars = { x: "{{ unknown_var }}" }
    const result = interpolateVariables(vars, ctx)
    expect(result.x).toBe("{{ unknown_var }}")
  })

  test("always injects environment even with undefined variables", () => {
    const result = interpolateVariables(undefined, ctx)
    expect(result).toEqual({ environment: "prvw-42" })
  })

  test("always injects environment even with empty variables", () => {
    const result = interpolateVariables({}, ctx)
    expect(result).toEqual({ environment: "prvw-42" })
  })
})

describe("prVariableContext", () => {
  test("builds correct context for a PR event", () => {
    const ctx = prVariableContext({
      prNumber: 42,
      branch: "feature/foo",
      sha: "abc123",
      owner: "lamalex",
      repo: "yaffle",
    })
    expect(ctx.env).toBe("prvw-42")
    expect(ctx.pr_number).toBe("42")
    expect(ctx.branch).toBe("feature/foo")
    expect(ctx.sha).toBe("abc123")
    expect(ctx.owner).toBe("lamalex")
    expect(ctx.repo).toBe("yaffle")
  })
})

describe("pushVariableContext", () => {
  test("builds correct context for a push event", () => {
    const ctx = pushVariableContext({
      branch: "main",
      sha: "def456",
      owner: "lamalex",
      repo: "yaffle",
    })
    expect(ctx.env).toBe("production")
    expect(ctx.pr_number).toBe("")
    expect(ctx.branch).toBe("main")
    expect(ctx.sha).toBe("def456")
  })
})
