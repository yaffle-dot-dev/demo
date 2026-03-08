import { Hono } from "hono"

import { logger as log } from "../../lib/telemetry.ts"
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

// All routes require TFC authentication
registryRoute.use("*", tfcAuth())

// =============================================================================
// URL Mapping Helpers
// =============================================================================

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

    // Find the organization
    const org = await findOrgBySlug(namespace)
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
      workspace = await findPreviewWorkspace(org.id, workspacePath, previewContext.prNumber)
    }
    if (!workspace) {
      // Fall back to non-preview (e.g. main branch) workspace
      workspace = await findNonPreviewWorkspace(org.id, workspacePath)
    }

    if (!workspace) {
      return c.json(
        { errors: [{ status: "404", title: "Module not found", detail: `No workspace at path: ${workspacePath}` }] },
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

    // Find the organization
    const org = await findOrgBySlug(namespace)
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
      moduleName,
      version,
      workspaceId: resolved.workspace.id,
      stateVersionId: resolved.stateVersion.id,
      serial: resolved.stateVersion.serial,
      isPreview: resolved.isPreview,
    })

    // Build archive URL, preserving preview parameter
    let archiveUrl = `/tfc/registry/v1/modules/${namespace}/${moduleName}/${provider}/${version}/archive.tar.gz`
    if (previewParam) {
      archiveUrl += `?preview=${encodeURIComponent(previewParam)}`
    }

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
    const auth = c.get("tfcAuth")
    const previewParam = c.req.query("preview")

    // Provider must be "yaffle"
    if (provider !== "yaffle") {
      return c.json(
        { errors: [{ status: "404", title: "Module not found" }] },
        404,
      )
    }

    // Find the organization
    const org = await findOrgBySlug(namespace)
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
