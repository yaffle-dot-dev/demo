import { describe, expect, test } from "bun:test"

import { extractAxiomDataset } from "./telemetry.ts"

describe("traffic-controller telemetry helpers", () => {
  test("extracts the Axiom dataset from exporter headers", () => {
    expect(extractAxiomDataset("Authorization=Bearer abc,X-Axiom-Dataset=traffic-control-logs"))
      .toBe("traffic-control-logs")
  })

  test("returns null when no dataset header is present", () => {
    expect(extractAxiomDataset("Authorization=Bearer abc")).toBeNull()
  })
})
