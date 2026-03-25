import { Hono } from "hono"
import { z } from "zod"

import { requireAuth, AuthError } from "../lib/auth.ts"
import { findOrgBySlug, findOrgMembership } from "../db/queries/organizations.ts"
import {
  findOrgForRepo,
  setRepoMapping,
  removeRepoMapping,
  listRepoMappingsForOrg,
} from "../db/queries/repo-mappings.ts"
import { db } from "../lib/db.ts"
import { account } from "../db/auth-schema.ts"
import { eq, and } from "drizzle-orm"

export const repoMappingsRoute = new Hono()

/**
 * Resolve org from slug, verify user is an admin member.
 */
async function requireOrgAdmin(c: { req: { raw: { headers: Headers }; param: (key: string) => string } }) {
  let auth
  try {
    auth = await requireAuth(c.req.raw.headers)
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.code === "AUTH_REQUIRED" ? 401 : 403
      throw { status, body: { error: { code: err.code, message: err.message } } }
    }
    throw err
  }

  const slug = c.req.param("slug")
  const org = await findOrgBySlug(slug)
  if (!org) {
    throw { status: 404, body: { error: { code: "NOT_FOUND", message: "Organization not found" } } }
  }

  const membership = await findOrgMembership(org.id, auth.userId)
  if (!membership || membership.role !== "admin") {
    throw { status: 403, body: { error: { code: "FORBIDDEN", message: "Admin access required" } } }
  }

  return { auth, org }
}

/**
 * Verify the user has access to a GitHub installation via the GitHub API.
 */
async function verifyInstallationAccess(userId: string, installationId: number): Promise<boolean> {
  const rows = await db
    .select({ accessToken: account.accessToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "github")))
    .limit(1)

  const githubToken = rows[0]?.accessToken
  if (!githubToken) return false

  // Check if the user can access repos through this installation
  // A 200 response means the user has access; 403/404 means they don't
  const res = await fetch(
    `https://api.github.com/user/installations/${installationId}/repositories?per_page=1`,
    {
      headers: {
        Authorization: `token ${githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  )

  return res.ok
}

const createMappingSchema = z.object({
  installationId: z.number().int().positive(),
  githubRepoId: z.number().int().positive(),
})

/**
 * GET /api/orgs/:slug/repo-mappings
 *
 * List all repo-to-org mappings for this org.
 */
repoMappingsRoute.get("/:slug/repo-mappings", async (c) => {
  let ctx
  try {
    ctx = await requireOrgAdmin(c as any)
  } catch (err: any) {
    if (err.status && err.body) return c.json(err.body, err.status)
    throw err
  }

  const mappings = await listRepoMappingsForOrg(ctx.org.id)
  return c.json({ data: mappings })
})

/**
 * POST /api/orgs/:slug/repo-mappings
 *
 * Map a GitHub repo to this org.
 * Requires admin role and verified access to the GitHub installation.
 */
repoMappingsRoute.post("/:slug/repo-mappings", async (c) => {
  let ctx
  try {
    ctx = await requireOrgAdmin(c as any)
  } catch (err: any) {
    if (err.status && err.body) return c.json(err.body, err.status)
    throw err
  }

  let body: z.infer<typeof createMappingSchema>
  try {
    body = createMappingSchema.parse(await c.req.json())
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: err.errors[0].message } }, 400)
    }
    return c.json({ error: { code: "INVALID_JSON", message: "Invalid request body" } }, 400)
  }

  // Verify the user has access to this GitHub installation
  const hasAccess = await verifyInstallationAccess(ctx.auth.userId, body.installationId)
  if (!hasAccess) {
    return c.json({
      error: { code: "INSTALLATION_NOT_ACCESSIBLE", message: "You do not have access to this GitHub installation" },
    }, 403)
  }

  // Check if this repo is already mapped to a different org
  const existing = await findOrgForRepo(body.installationId, body.githubRepoId)
  if (existing && existing.orgId !== ctx.org.id) {
    return c.json({
      error: { code: "REPO_ALREADY_MAPPED", message: "This repository is already mapped to another organization" },
    }, 409)
  }

  const mapping = await setRepoMapping({
    orgId: ctx.org.id,
    installationId: body.installationId,
    githubRepoId: body.githubRepoId,
    createdBy: ctx.auth.userId,
  })

  return c.json({ data: mapping }, 201)
})

/**
 * DELETE /api/orgs/:slug/repo-mappings/:installationId/:repoId
 *
 * Remove a repo-to-org mapping. Future webhooks for this repo will be ignored.
 */
repoMappingsRoute.delete("/:slug/repo-mappings/:installationId/:repoId", async (c) => {
  let ctx
  try {
    ctx = await requireOrgAdmin(c as any)
  } catch (err: any) {
    if (err.status && err.body) return c.json(err.body, err.status)
    throw err
  }

  const installationId = Number(c.req.param("installationId"))
  const repoId = Number(c.req.param("repoId"))

  if (!Number.isFinite(installationId) || !Number.isFinite(repoId)) {
    return c.json({ error: { code: "VALIDATION_ERROR", message: "Invalid installation or repo ID" } }, 400)
  }

  // Verify the mapping belongs to this org before deleting
  const existing = await findOrgForRepo(installationId, repoId)
  if (!existing || existing.orgId !== ctx.org.id) {
    return c.json({ error: { code: "NOT_FOUND", message: "Mapping not found for this organization" } }, 404)
  }

  await removeRepoMapping(installationId, repoId)
  return c.json({ data: { removed: true } })
})
