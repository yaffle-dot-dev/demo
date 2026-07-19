import { afterAll, beforeEach, describe, expect, test } from "@yaffle/test"

import { sql } from "drizzle-orm"

import { createOrg } from "../db/queries/organizations.ts"
import { findWorkspaceById, lockWorkspace } from "../db/queries/workspaces.ts"
import { organizations, workspaces } from "../db/schema.ts"
import { db } from "./db.ts"
import {
  beginWorkspaceArchive,
  completeWorkspaceArchive,
  ensureTransientWorkspace,
} from "./workspace-service.ts"

function assertTestDatabase(): void {
  if (!process.env.DATABASE_URL?.includes("_test")) {
    throw new Error("Refusing to run workspace-service tests outside a test database")
  }
}

describe("beginWorkspaceArchive", () => {
  let workspaceId: string

  beforeEach(async () => {
    assertTestDatabase()
    await db.execute(sql`TRUNCATE TABLE ${workspaces}, ${organizations} CASCADE`)

    const org = await createOrg({ name: "Test Org", slug: "test-org" })
    const workspace = await ensureTransientWorkspace({
      orgId: org.id,
      orgSlug: org.slug,
      repo: "test-repo",
      environment: "pr-42",
      workspacePath: "infra",
      ref: "refs/heads/feature/test",
    })
    workspaceId = workspace.id
  })

  afterAll(async () => {
    assertTestDatabase()
    await db.execute(sql`TRUNCATE TABLE ${workspaces}, ${organizations} CASCADE`)
  })

  test("marks an unlocked workspace as destroying without taking the backend lock", async () => {
    const workspace = await beginWorkspaceArchive(workspaceId)

    expect(workspace).toMatchObject({
      status: "destroying",
      locked: false,
      lockedBy: null,
      lockId: null,
    })
  })

  test("records destroy intent without clearing another operation's backend lock", async () => {
    await lockWorkspace(workspaceId, "run:another-run", "Applying infrastructure")

    expect(await beginWorkspaceArchive(workspaceId)).toMatchObject({
      status: "destroying",
      locked: true,
      lockedBy: "run:another-run",
    })
    expect(await findWorkspaceById(workspaceId)).toMatchObject({
      status: "destroying",
      locked: true,
      lockedBy: "run:another-run",
    })
  })

  test("prevents a normal run from locking after destruction begins", async () => {
    await beginWorkspaceArchive(workspaceId)

    expect(
      await lockWorkspace(workspaceId, "run:normal-run", "Applying infrastructure"),
    ).toBeUndefined()
    expect(await findWorkspaceById(workspaceId)).toMatchObject({
      status: "destroying",
      locked: false,
      lockedBy: null,
    })
  })

  test("does not archive or clear a backend lock acquired before completion", async () => {
    await beginWorkspaceArchive(workspaceId)
    await lockWorkspace(workspaceId, "run:another-run", "Destroying infrastructure", {
      allowDestroying: true,
    })

    expect(await completeWorkspaceArchive(workspaceId)).toBeNull()
    expect(await findWorkspaceById(workspaceId)).toMatchObject({
      status: "destroying",
      locked: true,
      lockedBy: "run:another-run",
    })
  })

  test("archives the workspace after destruction succeeds", async () => {
    await beginWorkspaceArchive(workspaceId)

    expect(await completeWorkspaceArchive(workspaceId)).toMatchObject({
      status: "archived",
      locked: false,
      lockedBy: null,
      lockId: null,
    })
  })
})
