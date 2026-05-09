import { expect, test } from "@yaffle/test"

import { DependencyGraph } from "../../../packages/shared/src/dependency-graph"

import { computeDeployableDependencies, getDeployableExecutionOrder } from "./execution-graph"
import { defineDeployable } from "./types"

const controlPlane = {
  ...defineDeployable({
    name: "control-plane",
    root: "apps/control-plane",
    supports: { environmentKinds: ["named", "transient"] },
    workspaces: ["apps/control-plane/infra"],
    watchedPaths: ["apps/control-plane/"],
    build: async () => {},
    deploy: async () => {},
  }),
  descriptorPath: "apps/control-plane/control-plane.yaffle.deployable.ts",
}

const web = {
  ...defineDeployable({
    name: "web",
    root: "apps/web",
    supports: { environmentKinds: ["named", "transient"] },
    workspaces: ["apps/web/infra"],
    watchedPaths: ["apps/web/"],
    build: async () => {},
    deploy: async () => {},
  }),
  descriptorPath: "apps/web/web.yaffle.deployable.ts",
}

const marketing = {
  ...defineDeployable({
    name: "marketing",
    root: "apps/marketing",
    supports: { environmentKinds: ["named", "transient"] },
    workspaces: ["apps/marketing/infra"],
    watchedPaths: ["apps/marketing/"],
    build: async () => {},
    deploy: async () => {},
  }),
  descriptorPath: "apps/marketing/marketing.yaffle.deployable.ts",
}

test("computes deployable dependencies from workspace graph", () => {
  const graph = new DependencyGraph()
  graph.addDependency({
    source: "apps/web/infra",
    target: "apps/control-plane/infra",
    preview: "auto",
  })
  graph.addIsolatedNode("apps/marketing/infra")

  const nodes = computeDeployableDependencies([controlPlane, web, marketing], graph)
  const byName = new Map(nodes.map((node) => [node.deployable.name, node.dependencies]))

  expect(byName.get("control-plane")).toEqual([])
  expect(byName.get("web")).toEqual(["control-plane"])
  expect(byName.get("marketing")).toEqual([])
})

test("orders deployables topologically without blocking independent branches", () => {
  const order = getDeployableExecutionOrder([
    { deployable: web, dependencies: ["control-plane"] },
    { deployable: controlPlane, dependencies: [] },
    { deployable: marketing, dependencies: [] },
  ])

  expect(order.indexOf("control-plane")).toBeLessThan(order.indexOf("web"))
  expect(order).toContain("marketing")
})
