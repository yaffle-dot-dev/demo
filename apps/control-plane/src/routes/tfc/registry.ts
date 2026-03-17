import { Hono } from "hono"
import { createHmac } from "node:crypto"

import { logger as log } from "../../lib/telemetry.ts"
import { getEnv } from "../../lib/env.ts"
import {
  findOrgBySlug,
  findOrgMembership,
} from "../../db/queries/organizations.ts"
import {
  findNonPreviewWorkspace,
  findPreviewWorkspace,
} from "../../db/queries/workspaces.ts"
import {
  listStateVersionsForModule,
} from "../../db/queries/state-versions.ts"
import {
  tfcAuth,
  type TfcAuthContext,
} from "../../middleware/tfc-auth.ts"
import {
  generateShimModule,
} from "../../lib/module-generator.ts"
import {
  getOrGenerateModule,
} from "../../lib/module-cache.ts"
import {
  resolveModule,
  parsePreviewContext,
} from "../../lib/module-resolver.ts"

// Hono context variables for TFC auth
type TfcVariables = {
  tfcAuth: TfcAuthContext
}

/**
 * Terraform Module Registry Protocol implementation.
 *
 * Exposes Yaffle workspaces as Terraform modules that can be consumed via:
 *   module "vpc" {
 *     source = "yaffle.dev/acme/core-infrastructure/vpc"
 *   }
 *
 * Preview-aware resolution is supported via ?preview=pr-{n} query parameter:
 *   module "shared" {
 *     source = "yaffle.dev/acme/apps/shared/infra?preview=pr-42"
 *   }
 *
 * See: https://developer.hashicorp.com/terraform/internals/module-registry-protocol
 */
export const registryRoute = new Hono<{ Variables: TfcVariables }>()

// Most routes require TFC authentication
// Archive endpoint is accessed via redirect and needs special handling
registryRoute.use("*", async (c, next) => {
  // Skip auth for archive downloads - they come from X-Terraform-Get redirect
  // which doesn't include auth headers. We validate via signed token in URL.
  if (c.req.path.endsWith("/archive.tar.gz")) {
    return next()
  }
  return tfcAuth()(c, next)
})

// =============================================================================
// Archive URL Signing
// =============================================================================

const ARCHIVE_TOKEN_TTL_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Generate a signed token for archive downloads.
 * Token format: {expiry_timestamp}.{hmac_signature}
 */
function signArchiveUrl(path: string): string {
  const env = getEnv()
  const secret = env.betterAuthSecret || "dev-secret"
  const expiry = Date.now() + ARCHIVE_TOKEN_TTL_MS
  const data = `${path}:${expiry}`
  const signature = createHmac("sha256", secret).update(data).digest("base64url")
  return `${expiry}.${signature}`
}

/**
 * Verify a signed archive token.
 */
function verifyArchiveToken(path: string, token: string): boolean {
  const env = getEnv()
  const secret = env.betterAuthSecret || "dev-secret"

  const parts = token.split(".")
  if (parts.length !== 2) return false

  const [expiryStr, signature] = parts
  const expiry = parseInt(expiryStr, 10)

  // Check expiry
  if (isNaN(expiry) || Date.now() > expiry) return false

  // Verify signature
  const data = `${path}:${expiry}`
  const expectedSig = createHmac("sha256", secret).update(data).digest("base64url")
  return signature === expectedSig
}

// =============================================================================
// URL Mapping Helpers
// =============================================================================

/**
 * Parse namespace into org slug and repo name.
 *
 * Namespace format: "{org}--{repo}"
 *   "yaffle-dot-dev--yaffle" -> { orgSlug: "yaffle-dot-dev", repo: "yaffle" }
 *   "acme--infrastructure" -> { orgSlug: "acme", repo: "infrastructure" }
 *
 * Note: Org slugs can contain hyphens, so we split on the LAST "--" occurrence.
 */
function parseNamespace(namespace: string): { orgSlug: string; repo: string } | null {
  const lastSeparator = namespace.lastIndexOf("--")
  if (lastSeparator === -1) {
    return null
  }
  return {
    orgSlug: namespace.slice(0, lastSeparator),
    repo: namespace.slice(lastSeparator + 2),
  }
}

/**
 * Build namespace from org slug and repo name.
 */
export function buildNamespace(orgSlug: string, repo: string): string {
  return `${orgSlug}--${repo}`
}

/**
 * Parse module name back to workspace path.
 *
 * Module name uses `--` as path separator:
 *   "core-infrastructure--vpc" -> "core-infrastructure/vpc"
 *
 * Note: Workspace paths can have multiple segments:
 *   "apps--api--infra" -> "apps/api/infra"
 */
function moduleNameToWorkspacePath(moduleName: string): string {
  return moduleName.replace(/--/g, "/")
}

/**
 * Convert workspace path to module name.
 *
 * Workspace path uses `/` as separator:
 *   "core-infrastructure/vpc" -> "core-infrastructure--vpc"
 */
export function workspacePathToModuleName(workspacePath: string): string {
  return workspacePath.replace(/\//g, "--")
}

/**
 * Convert state version serial to semver-like version.
 * Version format: 1.0.{serial}
 */
function serialToVersion(serial: number): string {
  return `1.0.${serial}`
}

/**
 * Parse version string back to serial number.
 * Accepts "1.0.42" or "latest".
 */
function versionToSerial(version: string): number | "latest" {
  if (version === "latest") {
    return "latest"
  }
  const match = version.match(/^1\.0\.(\d+)$/)
  if (!match) {
    throw new Error(`Invalid version format: ${version}`)
  }
  return parseInt(match[1], 10)
}

/**
 * Check org membership and return 403 if not a member.
 */
async function checkOrgMembership(
  auth: TfcAuthContext,
  orgId: string,
): Promise<{ allowed: false; error: Response } | { allowed: true }> {
  if (auth.type === "user" && auth.userId) {
    const membership = await findOrgMembership(orgId, auth.userId)
    if (!membership) {
      return {
        allowed: false,
        error: new Response(
          JSON.stringify({ errors: [{ status: "403", title: "Not a member of this organization" }] }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
      }
    }
  }
  return { allowed: true }
}

// =============================================================================
// List Module Versions
// =============================================================================

/**
 * GET /tfc/registry/v1/modules/:namespace/:name/:provider/versions
 *
 * List available versions of a module.
 * Versions correspond to state version serials.
 *
 * Namespace format: "{org}--{repo}" (e.g., "yaffle-dot-dev--yaffle")
 *
 * Query parameters:
 * - preview: "pr-{n}" to list versions from a preview workspace
 */
registryRoute.get(
  "/:namespace/:name/:provider/versions",
  async (c) => {
    const namespace = c.req.param("namespace")
    const moduleName = c.req.param("name")
    const provider = c.req.param("provider")
    const auth = c.get("tfcAuth")
    const previewParam = c.req.query("preview")

    // Provider must be "yaffle" for our modules
    if (provider !== "yaffle") {
      return c.json(
        { errors: [{ status: "404", title: "Module not found", detail: "Provider must be 'yaffle'" }] },
        404,
      )
    }

    // Parse namespace into org and repo
    const parsed = parseNamespace(namespace)
    if (!parsed) {
      return c.json(
        { errors: [{ status: "400", title: "Invalid namespace", detail: "Namespace must be in format: {org}--{repo}" }] },
        400,
      )
    }
    const { orgSlug, repo } = parsed

    // Find the organization
    const org = await findOrgBySlug(orgSlug)
    if (!org) {
      return c.json(
        { errors: [{ status: "404", title: "Namespace not found" }] },
        404,
      )
    }

    // Check org membership
    const membershipCheck = await checkOrgMembership(auth, org.id)
    if (!membershipCheck.allowed && "error" in membershipCheck) {
      return membershipCheck.error
    }

    // Convert module name to workspace path
    const workspacePath = moduleNameToWorkspacePath(moduleName)

    // Parse preview context
    const previewContext = parsePreviewContext(previewParam ?? null)

    // Find the appropriate workspace
    let workspace
    if (previewContext) {
      // Try preview workspace first
      workspace = await findPreviewWorkspace(org.id, repo, workspacePath, previewContext.prNumber)
    }
    if (!workspace) {
      // Fall back to non-preview (e.g. main branch) workspace
      workspace = await findNonPreviewWorkspace(org.id, repo, workspacePath)
    }

    if (!workspace) {
      return c.json(
        { errors: [{ status: "404", title: "Module not found", detail: `No workspace at path: ${workspacePath} in repo: ${repo}` }] },
        404,
      )
    }

    // List finalized state versions
    const stateVersions = await listStateVersionsForModule(workspace.id)

    // Map to version format
    const versions = stateVersions.map((sv) => ({
      version: serialToVersion(sv.serial),
    }))

    log.info("Module versions listed", {
      namespace,
      orgSlug,
      repo,
      moduleName,
      workspacePath,
      workspaceId: workspace.id,
      versionCount: versions.length,
      isPreview: workspace.environment === "preview",
    })

    // Return in Terraform module registry format
    return c.json({
      modules: [
        {
          versions,
        },
      ],
    })
  },
)

// =============================================================================
// Download Module
// =============================================================================

/**
 * GET /tfc/registry/v1/modules/:namespace/:name/:provider/:version/download
 *
 * Returns a redirect URL to download the module archive.
 * The Terraform CLI follows the X-Terraform-Get header to get the actual module.
 *
 * Namespace format: "{org}--{repo}" (e.g., "yaffle-dot-dev--yaffle")
 *
 * Query parameters:
 * - preview: "pr-{n}" to download from a preview workspace
 */
registryRoute.get(
  "/:namespace/:name/:provider/:version/download",
  async (c) => {
    const namespace = c.req.param("namespace")
    const moduleName = c.req.param("name")
    const provider = c.req.param("provider")
    const version = c.req.param("version")
    const auth = c.get("tfcAuth")
    const previewParam = c.req.query("preview")

    // Provider must be "yaffle"
    if (provider !== "yaffle") {
      return c.json(
        { errors: [{ status: "404", title: "Module not found" }] },
        404,
      )
    }

    // Parse namespace into org and repo
    const parsed = parseNamespace(namespace)
    if (!parsed) {
      return c.json(
        { errors: [{ status: "400", title: "Invalid namespace", detail: "Namespace must be in format: {org}--{repo}" }] },
        400,
      )
    }
    const { orgSlug, repo } = parsed

    // Find the organization
    const org = await findOrgBySlug(orgSlug)
    if (!org) {
      return c.json(
        { errors: [{ status: "404", title: "Namespace not found" }] },
        404,
      )
    }

    // Check org membership
    const membershipCheck = await checkOrgMembership(auth, org.id)
    if (!membershipCheck.allowed && "error" in membershipCheck) {
      return membershipCheck.error
    }

    // Parse version
    let serial: number | "latest"
    try {
      serial = versionToSerial(version)
    } catch {
      return c.json(
        { errors: [{ status: "400", title: "Invalid version format" }] },
        400,
      )
    }

    // Convert module name to workspace path
    const workspacePath = moduleNameToWorkspacePath(moduleName)

    // Parse preview context
    const previewContext = parsePreviewContext(previewParam ?? null)

    // Resolve the module
    const resolved = await resolveModule({
      orgId: org.id,
      repo,
      workspacePath,
      serial,
      previewContext,
    })

    if (!resolved) {
      return c.json(
        { errors: [{ status: "404", title: "Module not found" }] },
        404,
      )
    }

    log.info("Module download requested", {
      namespace,
      orgSlug,
      repo,
      moduleName,
      version,
      workspaceId: resolved.workspace.id,
      stateVersionId: resolved.stateVersion.id,
      serial: resolved.stateVersion.serial,
      isPreview: resolved.isPreview,
    })

    // Build archive URL with signed token
    const archivePath = `/tfc/registry/v1/modules/${namespace}/${moduleName}/${provider}/${version}/archive.tar.gz`
    const token = signArchiveUrl(archivePath)
    const params = new URLSearchParams({ token })
    if (previewParam) {
      params.set("preview", previewParam)
    }
    const archiveUrl = `${archivePath}?${params.toString()}`

    return new Response(null, {
      status: 204,
      headers: {
        "X-Terraform-Get": archiveUrl,
      },
    })
  },
)

// =============================================================================
// Module Archive (Generated Shim Module)
// =============================================================================

/**
 * GET /tfc/registry/v1/modules/:namespace/:name/:provider/:version/archive.tar.gz
 *
 * Returns the generated shim module as a tar.gz archive.
 * This is called by Terraform CLI after following the X-Terraform-Get header.
 *
 * Namespace format: "{org}--{repo}" (e.g., "yaffle-dot-dev--yaffle")
 *
 * Query parameters:
 * - preview: "pr-{n}" to download from a preview workspace
 */
registryRoute.get(
  "/:namespace/:name/:provider/:version/archive.tar.gz",
  async (c) => {
    const namespace = c.req.param("namespace")
    const moduleName = c.req.param("name")
    const provider = c.req.param("provider")
    const version = c.req.param("version")
    const previewParam = c.req.query("preview")
    const token = c.req.query("token")

    // Verify signed token (archive downloads don't have auth headers)
    const archivePath = `/tfc/registry/v1/modules/${namespace}/${moduleName}/${provider}/${version}/archive.tar.gz`
    if (!token || !verifyArchiveToken(archivePath, token)) {
      return c.json(
        { errors: [{ status: "401", title: "Invalid or expired token" }] },
        401,
      )
    }

    // Provider must be "yaffle"
    if (provider !== "yaffle") {
      return c.json(
        { errors: [{ status: "404", title: "Module not found" }] },
        404,
      )
    }

    // Parse namespace into org and repo
    const parsed = parseNamespace(namespace)
    if (!parsed) {
      return c.json(
        { errors: [{ status: "400", title: "Invalid namespace", detail: "Namespace must be in format: {org}--{repo}" }] },
        400,
      )
    }
    const { orgSlug, repo } = parsed

    // Find the organization
    const org = await findOrgBySlug(orgSlug)
    if (!org) {
      return c.json(
        { errors: [{ status: "404", title: "Namespace not found" }] },
        404,
      )
    }

    // Token was verified, no need for membership check on archive download
    // (membership was checked when the download URL was generated)

    // Parse version
    let serial: number | "latest"
    try {
      serial = versionToSerial(version)
    } catch {
      return c.json(
        { errors: [{ status: "400", title: "Invalid version format" }] },
        400,
      )
    }

    // Convert module name to workspace path
    const workspacePath = moduleNameToWorkspacePath(moduleName)

    // Parse preview context
    const previewContext = parsePreviewContext(previewParam ?? null)

    // Resolve the module
    const resolved = await resolveModule({
      orgId: org.id,
      repo,
      workspacePath,
      serial,
      previewContext,
    })

    if (!resolved) {
      return c.json(
        { errors: [{ status: "404", title: "Module not found" }] },
        404,
      )
    }

    const { workspace, stateVersion, isPreview } = resolved

    // Get or generate the shim module (with S3 caching)
    const archive = await getOrGenerateModule(
      workspace.id,
      stateVersion.serial,
      async () => generateShimModule({
        workspacePath,
        serial: stateVersion.serial,
        outputs: stateVersion.outputs as Record<string, unknown> | null,
      }),
    )

    log.info("Module archive served", {
      namespace,
      moduleName,
      version,
      workspaceId: workspace.id,
      stateVersionId: stateVersion.id,
      archiveSize: archive.length,
      isPreview,
    })

    return new Response(archive.buffer as ArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${moduleName}-${version}.tar.gz"`,
      },
    })
  },
)
