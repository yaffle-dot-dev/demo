import { describe, expect, test } from "@yaffle/test"

import {
  moduleNameToWorkspacePath,
  workspacePathToModuleName,
} from "./module-dependency-scanner"

describe("module dependency scanner helpers", () => {
  test("converts module names back to workspace paths", () => {
    expect(moduleNameToWorkspacePath("apps--web--infra")).toBe("apps/web/infra")
  })

  test("converts workspace paths to module names", () => {
    expect(workspacePathToModuleName("apps/web/infra")).toBe("apps--web--infra")
  })
})
