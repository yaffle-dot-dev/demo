import { describe, expect, test } from "@yaffle/test"

import { connectionScopesOverlap } from "./connection-scope.ts"

function mockConnection(config: Record<string, unknown>) {
  return {
    type: "envvar",
    providerType: typeof config.providerType === "string" ? config.providerType : null,
    config,
  }
}

describe("connectionScopesOverlap", () => {
  test("returns false for different providers", () => {
    const existing = mockConnection({
      providerType: "aws",
      environmentScope: ["production"],
      workspaceScope: ["infra/*"],
    })

    const incoming = {
      providerType: "cloudflare",
      environmentScope: ["production"],
      workspaceScope: ["infra/*"],
    }

    expect(connectionScopesOverlap(existing, incoming)).toBe(false)
  })

  test("returns true for overlapping exact scopes", () => {
    const existing = mockConnection({
      providerType: "aws",
      environmentScope: ["production"],
      workspaceScope: ["infra/shared"],
    })

    const incoming = {
      providerType: "aws",
      environmentScope: ["production"],
      workspaceScope: ["infra/shared"],
    }

    expect(connectionScopesOverlap(existing, incoming)).toBe(true)
  })

  test("returns true when wildcard workspace overlaps exact workspace", () => {
    const existing = mockConnection({
      providerType: "aws",
      environmentScope: ["production"],
      workspaceScope: ["infra/*"],
    })

    const incoming = {
      providerType: "aws",
      environmentScope: ["production"],
      workspaceScope: ["infra/shared"],
    }

    expect(connectionScopesOverlap(existing, incoming)).toBe(true)
  })

  test("returns true when wildcard transient env overlaps exact PR env", () => {
    const existing = mockConnection({
      providerType: "cloudflare",
      environmentScope: ["pr-*"],
      workspaceScope: ["apps/*"],
    })

    const incoming = {
      providerType: "cloudflare",
      environmentScope: ["pr-123"],
      workspaceScope: ["apps/web"],
    }

    expect(connectionScopesOverlap(existing, incoming)).toBe(true)
  })

  test("returns false when env scope does not overlap", () => {
    const existing = mockConnection({
      providerType: "aws",
      environmentScope: ["production"],
      workspaceScope: ["infra/*"],
    })

    const incoming = {
      providerType: "aws",
      environmentScope: ["staging"],
      workspaceScope: ["infra/shared"],
    }

    expect(connectionScopesOverlap(existing, incoming)).toBe(false)
  })
})
