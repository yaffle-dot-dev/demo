import { describe, expect, test } from "@yaffle/test"

import { DependencyGraph, matchGlobPattern } from "@yaffle/shared"

describe("DependencyGraph", () => {
  test("tracks direct dependencies", () => {
    const graph = new DependencyGraph()
    graph.addDependency({
      source: "apps/api/infra",
      target: "core/vpc",
      preview: "never",
    })
    graph.addDependency({
      source: "apps/api/infra",
      target: "core/eks",
      preview: "auto",
    })

    const deps = graph.getDependencies("apps/api/infra")
    expect(deps).toContain("core/vpc")
    expect(deps).toContain("core/eks")
    expect(deps).toHaveLength(2)
  })

  test("tracks dependents (reverse index)", () => {
    const graph = new DependencyGraph()
    graph.addDependency({
      source: "apps/api/infra",
      target: "core/vpc",
      preview: "never",
    })
    graph.addDependency({
      source: "apps/web/infra",
      target: "core/vpc",
      preview: "never",
    })

    const dependents = graph.getDependents("core/vpc")
    expect(dependents).toContain("apps/api/infra")
    expect(dependents).toContain("apps/web/infra")
    expect(dependents).toHaveLength(2)
  })

  test("stores dependency metadata", () => {
    const graph = new DependencyGraph()
    graph.addDependency({
      source: "apps/api/infra",
      target: "core/vpc",
      preview: "never",
    })

    const meta = graph.getDependencyMetadata("apps/api/infra", "core/vpc")
    expect(meta?.preview).toBe("never")
  })

  test("detects direct cycle", () => {
    const graph = new DependencyGraph()
    graph.addDependency({ source: "A", target: "B", preview: "auto" })
    graph.addDependency({ source: "B", target: "A", preview: "auto" })

    const result = graph.detectCycle()
    expect(result.hasCycle).toBe(true)
    expect(result.cyclePath).toBeDefined()
  })

  test("detects indirect cycle", () => {
    const graph = new DependencyGraph()
    graph.addDependency({ source: "A", target: "B", preview: "auto" })
    graph.addDependency({ source: "B", target: "C", preview: "auto" })
    graph.addDependency({ source: "C", target: "A", preview: "auto" })

    const result = graph.detectCycle()
    expect(result.hasCycle).toBe(true)
    expect(result.cyclePath).toBeDefined()
    expect(result.cyclePath?.length).toBe(3)
  })

  test("no false positive on diamond dependency", () => {
    const graph = new DependencyGraph()
    // Diamond: A -> B -> D, A -> C -> D
    graph.addDependency({ source: "A", target: "B", preview: "auto" })
    graph.addDependency({ source: "A", target: "C", preview: "auto" })
    graph.addDependency({ source: "B", target: "D", preview: "auto" })
    graph.addDependency({ source: "C", target: "D", preview: "auto" })

    const result = graph.detectCycle()
    expect(result.hasCycle).toBe(false)
  })

  test("gets transitive dependencies", () => {
    const graph = new DependencyGraph()
    graph.addDependency({ source: "A", target: "B", preview: "auto" })
    graph.addDependency({ source: "B", target: "C", preview: "auto" })
    graph.addDependency({ source: "C", target: "D", preview: "auto" })

    const deps = graph.getTransitiveDependencies("A")
    expect(deps).toContain("B")
    expect(deps).toContain("C")
    expect(deps).toContain("D")
    expect(deps).toHaveLength(3)
  })

  test("gets transitive dependents (blast radius)", () => {
    const graph = new DependencyGraph()
    graph.addDependency({ source: "apps/api", target: "core/vpc", preview: "auto" })
    graph.addDependency({ source: "apps/web", target: "core/vpc", preview: "auto" })
    graph.addDependency({ source: "apps/mobile", target: "apps/api", preview: "auto" })

    // Changing core/vpc affects apps/api, apps/web, and transitively apps/mobile
    const affected = graph.getTransitiveDependents("core/vpc")
    expect(affected).toContain("apps/api")
    expect(affected).toContain("apps/web")
    expect(affected).toContain("apps/mobile")
  })

  test("topological order respects dependencies", () => {
    const graph = new DependencyGraph()
    graph.addDependency({ source: "apps/api", target: "core/vpc", preview: "auto" })
    graph.addDependency({ source: "apps/api", target: "core/eks", preview: "auto" })
    graph.addDependency({ source: "core/eks", target: "core/vpc", preview: "auto" })

    const order = graph.getTopologicalOrder()
    expect(order).not.toBeNull()

    // vpc should come before eks (eks depends on vpc)
    const vpcIdx = order!.indexOf("core/vpc")
    const eksIdx = order!.indexOf("core/eks")
    const apiIdx = order!.indexOf("apps/api")

    expect(vpcIdx).toBeLessThan(eksIdx)
    expect(eksIdx).toBeLessThan(apiIdx)
  })

  test("topological order returns null on cycle", () => {
    const graph = new DependencyGraph()
    graph.addDependency({ source: "A", target: "B", preview: "auto" })
    graph.addDependency({ source: "B", target: "A", preview: "auto" })

    const order = graph.getTopologicalOrder()
    expect(order).toBeNull()
  })
})

describe("Consumer allowlist", () => {
  test("allows any consumer when no patterns defined", () => {
    const graph = new DependencyGraph()
    // No consumers set for core/vpc

    expect(graph.isConsumerAllowed("apps/anything", "core/vpc")).toBe(true)
  })

  test("denies all consumers when patterns is empty", () => {
    const graph = new DependencyGraph()
    graph.setConsumers("core/secret", [])

    expect(graph.isConsumerAllowed("apps/api", "core/secret")).toBe(false)
  })

  test("allows matching consumer", () => {
    const graph = new DependencyGraph()
    graph.setConsumers("core/vpc", ["apps/*"])

    expect(graph.isConsumerAllowed("apps/api", "core/vpc")).toBe(true)
    expect(graph.isConsumerAllowed("apps/web", "core/vpc")).toBe(true)
  })

  test("denies non-matching consumer", () => {
    const graph = new DependencyGraph()
    graph.setConsumers("core/vpc", ["apps/*"])

    expect(graph.isConsumerAllowed("services/worker", "core/vpc")).toBe(false)
  })

  test("supports multiple patterns", () => {
    const graph = new DependencyGraph()
    graph.setConsumers("core/vpc", ["apps/*", "services/*"])

    expect(graph.isConsumerAllowed("apps/api", "core/vpc")).toBe(true)
    expect(graph.isConsumerAllowed("services/worker", "core/vpc")).toBe(true)
    expect(graph.isConsumerAllowed("platform/monitoring", "core/vpc")).toBe(false)
  })
})

describe("matchGlobPattern", () => {
  test("matches exact path", () => {
    expect(matchGlobPattern("apps/api", "apps/api")).toBe(true)
    expect(matchGlobPattern("apps/api", "apps/web")).toBe(false)
  })

  test("matches single segment wildcard", () => {
    expect(matchGlobPattern("apps/*", "apps/api")).toBe(true)
    expect(matchGlobPattern("apps/*", "apps/web")).toBe(true)
    expect(matchGlobPattern("apps/*", "apps/api/v2")).toBe(false)
  })

  test("matches double star (any depth)", () => {
    expect(matchGlobPattern("apps/**", "apps/api")).toBe(true)
    expect(matchGlobPattern("apps/**", "apps/api/v2")).toBe(true)
    expect(matchGlobPattern("apps/**", "apps/api/v2/infra")).toBe(true)
  })

  test("matches middle wildcard", () => {
    expect(matchGlobPattern("apps/*/infra", "apps/api/infra")).toBe(true)
    expect(matchGlobPattern("apps/*/infra", "apps/web/infra")).toBe(true)
    expect(matchGlobPattern("apps/*/infra", "apps/api/something")).toBe(false)
  })
})

describe("Serialization", () => {
  test("roundtrips through JSON", () => {
    const graph = new DependencyGraph()
    graph.addDependency({ source: "A", target: "B", preview: "never" })
    graph.addDependency({ source: "A", target: "C", preview: "always" })
    graph.setConsumers("B", ["A", "D/*"])

    const json = graph.toJSON()
    const restored = DependencyGraph.fromJSON(json)

    expect(restored.getDependencies("A")).toEqual(["B", "C"])
    expect(restored.getDependencyMetadata("A", "B")?.preview).toBe("never")
    expect(restored.getDependencyMetadata("A", "C")?.preview).toBe("always")
    expect(restored.getConsumerPatterns("B")).toEqual(["A", "D/*"])
  })
})
