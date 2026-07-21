import { afterEach, beforeEach, describe, expect, test } from "@yaffle/test"
import { eq } from "drizzle-orm"

import { db } from "../../lib/db.ts"
import { cleanupTestData } from "../../test-utils/auth.ts"
import {
  anonymousSessions,
  hostedOutputModules,
  principalRepoBindings,
  principals,
} from "../schema.ts"
import {
  createAnonymousSession,
  createPrincipal,
  deleteExpiredAnonymousPrincipalsBefore,
  ensurePrincipalRepoBinding,
  expireInactiveAnonymousSessions,
  findAnonymousSessionById,
  findHostedOutputModuleVersion,
  findPrincipalById,
  listHostedOutputModuleVersions,
  publishHostedOutputModule,
} from "./principals.ts"

describe("principal local-first lifecycle queries", () => {
  beforeEach(async () => {
    await cleanupTestData()
  })

  afterEach(async () => {
    await cleanupTestData()
  })

  test("expires inactive anonymous sessions and principals", async () => {
    const stalePrincipal = await createPrincipal({ type: "anonymous_session" })
    const staleSession = await createAnonymousSession({
      principalId: stalePrincipal.id,
      expiresAt: new Date("2030-04-28T00:00:00.000Z"),
    })
    const freshPrincipal = await createPrincipal({ type: "anonymous_session" })
    const freshSession = await createAnonymousSession({
      principalId: freshPrincipal.id,
      expiresAt: new Date("2030-04-28T00:00:00.000Z"),
    })

    const staleSeenAt = new Date("2026-04-01T00:00:00.000Z")
    await db
      .update(principals)
      .set({ lastSeenAt: staleSeenAt })
      .where(eq(principals.id, stalePrincipal.id))
    await db
      .update(anonymousSessions)
      .set({ lastSeenAt: staleSeenAt })
      .where(eq(anonymousSessions.id, staleSession.id))

    const result = await expireInactiveAnonymousSessions(new Date("2026-04-15T00:00:00.000Z"))

    expect(result).toEqual({ principalCount: 1, sessionCount: 1 })

    const expiredRecord = await findAnonymousSessionById(staleSession.id)
    const activeRecord = await findAnonymousSessionById(freshSession.id)

    expect(expiredRecord?.principal.status).toBe("expired")
    expect(expiredRecord?.session.status).toBe("expired")
    expect(activeRecord?.principal.status).toBe("active")
    expect(activeRecord?.session.status).toBe("active")
  })

  test("deletes expired anonymous principals after retention cutoff", async () => {
    const expiredPrincipal = await createPrincipal({ type: "anonymous_session" })
    const expiredSession = await createAnonymousSession({
      principalId: expiredPrincipal.id,
      expiresAt: new Date("2026-04-10T00:00:00.000Z"),
    })
    const binding = await ensurePrincipalRepoBinding({
      principalId: expiredPrincipal.id,
      canonicalRepoNamespace: "test-org--fixture",
      localRepoFingerprint: "repo-fingerprint-1",
    })
    const published = await publishHostedOutputModule({
      principalId: expiredPrincipal.id,
      repoBindingId: binding.id,
      canonicalRepoNamespace: "test-org--fixture",
      environmentName: "main",
      workspacePath: "infra/shared",
      stateFingerprint: "state-md5-v1",
      outputs: {},
    })

    const freshPrincipal = await createPrincipal({ type: "anonymous_session" })
    await createAnonymousSession({
      principalId: freshPrincipal.id,
      expiresAt: new Date("2030-04-28T00:00:00.000Z"),
    })

    const expiredLastSeenAt = new Date("2026-04-01T00:00:00.000Z")
    await db
      .update(principals)
      .set({ status: "expired", lastSeenAt: expiredLastSeenAt })
      .where(eq(principals.id, expiredPrincipal.id))
    await db
      .update(anonymousSessions)
      .set({ status: "expired", lastSeenAt: expiredLastSeenAt })
      .where(eq(anonymousSessions.id, expiredSession.id))

    const result = await deleteExpiredAnonymousPrincipalsBefore(
      new Date("2026-04-15T00:00:00.000Z"),
    )

    expect(result).toEqual({
      principalCount: 1,
      sessionCount: 1,
      repoBindingCount: 1,
      hostedOutputModuleCount: 1,
    })

    expect(await findPrincipalById(expiredPrincipal.id)).toBeUndefined()

    const remainingSessionRows = await db
      .select()
      .from(anonymousSessions)
      .where(eq(anonymousSessions.id, expiredSession.id))
    const remainingBindingRows = await db
      .select()
      .from(principalRepoBindings)
      .where(eq(principalRepoBindings.id, binding.id))
    const remainingModuleRows = await db
      .select()
      .from(hostedOutputModules)
      .where(eq(hostedOutputModules.id, published.id))

    expect(remainingSessionRows).toHaveLength(0)
    expect(remainingBindingRows).toHaveLength(0)
    expect(remainingModuleRows).toHaveLength(0)
    expect(await findPrincipalById(freshPrincipal.id)).toBeTruthy()
  })

  test("isolates hosted output modules by principal repository binding", async () => {
    const firstPrincipal = await createPrincipal({ type: "anonymous_session" })
    const secondPrincipal = await createPrincipal({ type: "anonymous_session" })
    const firstBinding = await ensurePrincipalRepoBinding({
      principalId: firstPrincipal.id,
      canonicalRepoNamespace: "test-org--shared-name",
      localRepoFingerprint: "first-fingerprint",
    })
    const secondBinding = await ensurePrincipalRepoBinding({
      principalId: secondPrincipal.id,
      canonicalRepoNamespace: "test-org--shared-name",
      localRepoFingerprint: "second-fingerprint",
    })
    const firstModule = await publishHostedOutputModule({
      principalId: firstPrincipal.id,
      repoBindingId: firstBinding.id,
      canonicalRepoNamespace: "test-org--shared-name",
      environmentName: "main",
      workspacePath: "infra",
      stateFingerprint: "first-state",
      outputs: { endpoint: { value: "first", sensitive: false } },
    })
    await publishHostedOutputModule({
      principalId: secondPrincipal.id,
      repoBindingId: secondBinding.id,
      canonicalRepoNamespace: "test-org--shared-name",
      environmentName: "main",
      workspacePath: "infra",
      stateFingerprint: "second-state",
      outputs: { endpoint: { value: "second", sensitive: false } },
    })

    const versions = await listHostedOutputModuleVersions({
      repoBindingId: firstBinding.id,
      canonicalRepoNamespace: "test-org--shared-name",
      environmentName: "main",
      workspacePath: "infra",
    })
    expect(versions.map((version) => version.id)).toEqual([firstModule.id])
    expect(
      await findHostedOutputModuleVersion({
        repoBindingId: secondBinding.id,
        canonicalRepoNamespace: "test-org--shared-name",
        environmentName: "main",
        workspacePath: "infra",
        versionSerial: firstModule.versionSerial,
      }),
    ).toBeUndefined()
  })
})
