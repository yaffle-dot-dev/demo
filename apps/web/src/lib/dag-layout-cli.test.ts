import { describe, expect, test } from "bun:test"

import {
  buildOrthogonalEdgePaths,
  computeCliAlignedColumns,
} from "./dag-layout-cli"

describe("computeCliAlignedColumns", () => {
  test("mirrors cli stage ordering for dependency columns", () => {
    const items = [
      { id: "infra/shared" },
      { id: "infra/production" },
      { id: "infra/nonprod" },
      { id: "apps/runner/infra" },
      { id: "apps/control-plane/infra" },
      { id: "apps/web/infra" },
    ]

    const result = computeCliAlignedColumns(
      items,
      (item) => item.id,
      {
        workspaces: items.map((item) => item.id),
        edges: [
          ["apps/runner/infra", "infra/shared"],
          ["apps/runner/infra", "infra/production"],
          ["apps/runner/infra", "infra/nonprod"],
          ["apps/control-plane/infra", "infra/shared"],
          ["apps/control-plane/infra", "apps/runner/infra"],
          ["apps/web/infra", "apps/control-plane/infra"],
        ],
      },
      true,
    )

    expect(result.topologicalOrder).toEqual([
      "infra/shared",
      "infra/production",
      "infra/nonprod",
      "apps/runner/infra",
      "apps/control-plane/infra",
      "apps/web/infra",
    ])
    expect(result.columns.map((column) => column.map((item) => item.id))).toEqual([
      ["infra/shared", "infra/production", "infra/nonprod"],
      ["apps/runner/infra"],
      ["apps/control-plane/infra"],
      ["apps/web/infra"],
    ])
  })
})

describe("buildOrthogonalEdgePaths", () => {
  test("adds a bridge when a horizontal edge crosses another edge's vertical segment", () => {
    const paths = buildOrthogonalEdgePaths([
      {
        edgeId: "direct",
        sourceId: "a",
        targetId: "b",
        sourceX: 0,
        sourceY: 50,
        targetX: 100,
        targetY: 50,
        bendX: 0,
      },
      {
        edgeId: "orthogonal",
        sourceId: "c",
        targetId: "d",
        sourceX: 0,
        sourceY: 10,
        targetX: 100,
        targetY: 90,
        bendX: 50,
      },
    ])

    expect(paths.get("direct")).toContain("C")
    expect(paths.get("orthogonal")).toContain("L 50 90")
  })
})
