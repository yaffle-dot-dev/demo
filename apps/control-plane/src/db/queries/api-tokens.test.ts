import { describe, expect, test } from "bun:test"

import {
  DEFAULT_TFC_TOKEN_TTL_DAYS,
  TFC_SCOPES,
  getDefaultTfcScopesForRole,
  getDefaultTfcTokenExpiry,
} from "./api-tokens.ts"

describe("getDefaultTfcScopesForRole", () => {
  test("returns read-only scopes for viewers", () => {
    expect(getDefaultTfcScopesForRole("viewer")).toEqual([
      TFC_SCOPES.workspaceRead,
      TFC_SCOPES.stateRead,
      TFC_SCOPES.stateDownload,
    ])
  })

  test("returns write scopes for approvers", () => {
    expect(getDefaultTfcScopesForRole("approver")).toEqual([
      TFC_SCOPES.workspaceRead,
      TFC_SCOPES.workspaceWrite,
      TFC_SCOPES.workspaceLock,
      TFC_SCOPES.stateRead,
      TFC_SCOPES.stateWrite,
      TFC_SCOPES.stateDownload,
    ])
  })

  test("returns admin scopes for admins", () => {
    expect(getDefaultTfcScopesForRole("admin")).toContain(TFC_SCOPES.adminForceUnlock)
  })
})

describe("getDefaultTfcTokenExpiry", () => {
  test("defaults Terraform login tokens to 30 days", () => {
    const now = new Date("2026-03-23T00:00:00.000Z")
    const expiresAt = getDefaultTfcTokenExpiry(now)

    expect(expiresAt.toISOString()).toBe("2026-04-22T00:00:00.000Z")
    expect(DEFAULT_TFC_TOKEN_TTL_DAYS).toBe(30)
  })
})
