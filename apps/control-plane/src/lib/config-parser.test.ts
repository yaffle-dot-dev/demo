import { describe, expect, test } from "bun:test"

import {
  parseYaffleConfig,
  buildDependencyGraphFromConfig,
  validateDependencyGraph,
  getWorkspaceDependencies,
} from "./config-parser.ts"

describe("parseYaffleConfig", () => {
  test("parses minimal config", () => {
    const config = parseYaffleConfig(`
workspaces: []
`)
    expect(config.workspaces).toEqual([])
  })

  test("parses workspace with simple uses", () => {
    const config = parseYaffleConfig(`
workspaces:
  - path: apps/api/infra
    uses:
      - core-infrastructure/vpc
      - core-infrastructure/eks
`)
    expect(config.workspaces).toHaveLength(1)
    expect(config.workspaces![0].path).toBe("apps/api/infra")
    expect(config.workspaces![0].uses).toEqual([
      "core-infrastructure/vpc",
      "core-infrastructure/eks",
    ])
  })

  test("parses workspace with explicit preview settings", () => {
    const config = parseYaffleConfig(`
workspaces:
  - path: apps/api/infra
    uses:
      - workspace: core-infrastructure/vpc
        preview: never
      - workspace: apps/shared/infra
        preview: always
`)
    expect(config.workspaces![0].uses![0]).toEqual({
      workspace: "core-infrastructure/vpc",
      preview: "never",
    })
    expect(config.workspaces![0].uses![1]).toEqual({
      workspace: "apps/shared/infra",
      preview: "always",
    })
  })

  test("parses workspace with consumers", () => {
    const config = parseYaffleConfig(`
workspaces:
  - path: core-infrastructure/vpc
    consumers:
      - apps/*
      - services/*
`)
    expect(config.workspaces![0].consumers).toEqual(["apps/*", "services/*"])
  })

  test("parses mixed config", () => {
    const config = parseYaffleConfig(`
workspaces:
  - path: apps/api/infra
    uses:
      - core-infrastructure/vpc
      - workspace: apps/shared/infra
        preview: auto

  - path: core-infrastructure/vpc
    consumers:
      - apps/*
      - services/*
`)
    expect(config.workspaces).toHaveLength(2)
  })
})

describe("buildDependencyGraphFromConfig", () => {
  test("builds graph from simple uses", () => {
    const config = parseYaffleConfig(`
workspaces:
  - path: apps/api/infra
    uses:
      - core/vpc
      - core/eks
`)
    const graph = buildDependencyGraphFromConfig(config)

    const deps = graph.getDependencies("apps/api/infra")
    expect(deps).toContain("core/vpc")
    expect(deps).toContain("core/eks")
  })

  test("uses auto preview by default", () => {
    const config = parseYaffleConfig(`
workspaces:
  - path: apps/api/infra
    uses:
      - core/vpc
`)
    const graph = buildDependencyGraphFromConfig(config)

    const meta = graph.getDependencyMetadata("apps/api/infra", "core/vpc")
    expect(meta?.preview).toBe("auto")
  })

  test("respects explicit preview settings", () => {
    const config = parseYaffleConfig(`
workspaces:
  - path: apps/api/infra
    uses:
      - workspace: core/vpc
        preview: never
`)
    const graph = buildDependencyGraphFromConfig(config)

    const meta = graph.getDependencyMetadata("apps/api/infra", "core/vpc")
    expect(meta?.preview).toBe("never")
  })

  test("sets consumer patterns", () => {
    const config = parseYaffleConfig(`
workspaces:
  - path: core/vpc
    consumers:
      - apps/*
`)
    const graph = buildDependencyGraphFromConfig(config)

    expect(graph.getConsumerPatterns("core/vpc")).toEqual(["apps/*"])
    expect(graph.isConsumerAllowed("apps/api", "core/vpc")).toBe(true)
    expect(graph.isConsumerAllowed("services/worker", "core/vpc")).toBe(false)
  })
})

describe("validateDependencyGraph", () => {
  test("passes for valid DAG", () => {
    const config = parseYaffleConfig(`
workspaces:
  - path: apps/api
    uses:
      - core/vpc
  - path: core/vpc
`)
    const graph = buildDependencyGraphFromConfig(config)
    const result = validateDependencyGraph(graph)

    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  test("detects cycle", () => {
    const config = parseYaffleConfig(`
workspaces:
  - path: A
    uses:
      - B
  - path: B
    uses:
      - A
`)
    const graph = buildDependencyGraphFromConfig(config)
    const result = validateDependencyGraph(graph)

    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].type).toBe("cycle")
  })
})

describe("getWorkspaceDependencies", () => {
  test("returns empty for workspace without uses", () => {
    const config = parseYaffleConfig(`
workspaces:
  - path: core/vpc
`)
    const deps = getWorkspaceDependencies(config, "core/vpc")
    expect(deps).toEqual([])
  })

  test("returns empty for unknown workspace", () => {
    const config = parseYaffleConfig(`
workspaces:
  - path: core/vpc
`)
    const deps = getWorkspaceDependencies(config, "unknown/path")
    expect(deps).toEqual([])
  })

  test("returns dependencies with normalized preview", () => {
    const config = parseYaffleConfig(`
workspaces:
  - path: apps/api
    uses:
      - core/vpc
      - workspace: core/eks
        preview: never
`)
    const deps = getWorkspaceDependencies(config, "apps/api")

    expect(deps).toHaveLength(2)
    expect(deps[0]).toEqual({
      source: "apps/api",
      target: "core/vpc",
      preview: "auto",
    })
    expect(deps[1]).toEqual({
      source: "apps/api",
      target: "core/eks",
      preview: "never",
    })
  })
})
