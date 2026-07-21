import { Hono } from "hono"
import { createHmac } from "node:crypto"

import { logger as log } from "../../lib/telemetry.ts"
import { getEnv } from "../../lib/env.ts"
import { findOrgBySlug, findOrgById, findOrgMembership } from "../../db/queries/organizations.ts"
import {
  findNamedWorkspace,
  findTransientWorkspace,
  findWorkspaceById,
  type Workspace,
} from "../../db/queries/workspaces.ts"
import {
  findStateVersionById,
  listStateVersionsForModule,
} from "../../db/queries/state-versions.ts"
import {
  findHostedOutputModuleById,
  findHostedOutputModuleVersion,
  listHostedOutputModuleVersions,
} from "../../db/queries/principals.ts"
import { tfcAuth, type TfcAuthContext } from "../../middleware/tfc-auth.ts"
import { findRepoByFullName, findRepoByName } from "../../db/queries/repositories.ts"
import { fetchFileContent } from "../../lib/github.ts"
import { generateShimModule } from "../../lib/module-generator.ts"
import { getOrGenerateModule } from "../../lib/module-cache.ts"
import {
  parseTransientEnvironmentContext,
  resolveModule,
  type TransientEnvironmentContext,
} from "../../lib/module-resolver.ts"
import { parseYaffleToml, type YaffleTomlConfig } from "../../lib/config-toml.ts"
import {
  filterOutputsForAccess,
  findSensitiveExportedOutputs,
  resolveModuleAccessDecision,
  type ModuleConsumerWorkspace,
  type ProducerConfigState,
} from "../../lib/workspace-exports.ts"
import { buildHostedModuleVersion, parseHostedModuleVersion } from "../../lib/principal-tokens.ts"

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
 * Transient-aware resolution uses the source-neutral environment identity:
 *   module "shared" {
 *     source = "yaffle.dev/acme/apps/shared/infra?environment=review-42"
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

interface ArchiveTokenPayload {
  exp: number
  stateVersionId?: string
  hostedOutputModuleId?: string
  outputNames?: string[]
}

/**
 * Generate a signed token for archive downloads.
 * Token format: {expiry_timestamp}.{hmac_signature}
 */
function signArchiveUrl(path: string, payload: Omit<ArchiveTokenPayload, "exp">): string {
  const env = getEnv()
  const secret = env.betterAuthSecret || "dev-secret"
  const encodedPayload = Buffer.from(
    JSON.stringify({
      ...payload,
      exp: Date.now() + ARCHIVE_TOKEN_TTL_MS,
    }),
  ).toString("base64url")
  const signature = createHmac("sha256", secret)
    .update(`${path}:${encodedPayload}`)
    .digest("base64url")
  return `${encodedPayload}.${signature}`
}

/**
 * Verify a signed archive token.
 */
function verifyArchiveToken(path: string, token: string): ArchiveTokenPayload | null {
  const env = getEnv()
  const secret = env.betterAuthSecret || "dev-secret"

  const parts = token.split(".")
  if (parts.length !== 2) return null

  const [encodedPayload, signature] = parts
  const expectedSig = createHmac("sha256", secret)
    .update(`${path}:${encodedPayload}`)
    .digest("base64url")
  if (signature !== expectedSig) {
    return null
  }

  let payload: ArchiveTokenPayload
  try {
    payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf-8"),
    ) as ArchiveTokenPayload
  } catch {
    return null
  }

  // Check expiry
  if (typeof payload.exp !== "number" || Date.now() > payload.exp) {
    return null
  }

  if (
    typeof payload.stateVersionId !== "string" &&
    (typeof payload.hostedOutputModuleId !== "string" || payload.hostedOutputModuleId.length === 0)
  ) {
    return null
  }

  if (payload.outputNames && !Array.isArray(payload.outputNames)) {
    return null
  }

  return payload
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
          JSON.stringify({
            errors: [{ status: "403", title: "Not a member of this organization" }],
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
      }
    }
  }
  return { allowed: true }
}

function parseRepoRef(repoRef: string, fallbackOwner: string): { owner: string; repo: string } {
  if (repoRef.includes("/")) {
    const [owner, repo] = repoRef.split("/", 2)
    return { owner, repo }
  }

  return { owner: fallbackOwner, repo: repoRef }
}

async function resolveConsumerWorkspace(
  auth: TfcAuthContext,
): Promise<ModuleConsumerWorkspace | null> {
  if (auth.type !== "run" || !auth.workspaceId) {
    return null
  }

  const workspace = await findWorkspaceById(auth.workspaceId)
  if (!workspace) {
    return null
  }

  const org = await findOrgById(workspace.orgId)
  if (!org) {
    return null
  }

  const repository = workspace.repo.includes("/")
    ? ((await findRepoByFullName(workspace.repo)) ??
      (await findRepoByName(workspace.orgId, workspace.repo.split("/").pop() ?? workspace.repo)))
    : await findRepoByName(workspace.orgId, workspace.repo)

  return {
    orgId: workspace.orgId,
    orgSlug: org.slug,
    repo: repository?.fullName ?? workspace.repo,
    workspacePath: workspace.workspacePath,
    environmentKind: workspace.environmentKind,
    environmentName: workspace.environmentName,
  }
}

function deriveTransientEnvironment(options: {
  explicitEnvironment: TransientEnvironmentContext | null
  consumerWorkspace: ModuleConsumerWorkspace | null
}): { allowed: true; environment: TransientEnvironmentContext | null } | { allowed: false } {
  const consumer = options.consumerWorkspace
  if (!consumer) {
    return { allowed: true, environment: options.explicitEnvironment }
  }

  const boundEnvironment =
    consumer.environmentKind === "transient"
      ? parseTransientEnvironmentContext(consumer.environmentName)
      : null
  if (
    options.explicitEnvironment &&
    options.explicitEnvironment.environmentName !== boundEnvironment?.environmentName
  ) {
    return { allowed: false }
  }

  return { allowed: true, environment: boundEnvironment }
}

async function loadProducerConfig(
  workspace: Workspace,
  producerOrgSlug: string,
): Promise<{ state: ProducerConfigState; config: YaffleTomlConfig | null }> {
  const { owner, repo } = parseRepoRef(workspace.repo, producerOrgSlug)
  const repository = workspace.repo.includes("/")
    ? ((await findRepoByFullName(`${owner}/${repo}`)) ??
      (await findRepoByName(workspace.orgId, repo)))
    : await findRepoByName(workspace.orgId, repo)

  const resolvedOwner = repository?.fullName.split("/")[0] ?? owner
  const installationId = repository?.installationId
  if (!installationId) {
    return { state: "missing", config: null }
  }

  try {
    const rawConfig = await fetchFileContent(
      installationId,
      resolvedOwner,
      repo,
      "yaffle.toml",
      workspace.ref,
    )

    return rawConfig
      ? { state: "loaded", config: parseYaffleToml(rawConfig) }
      : { state: "missing", config: null }
  } catch (err) {
    log.warn("Failed to load producer yaffle.toml for module registry authz", {
      workspaceId: workspace.id,
      repo: workspace.repo,
      ref: workspace.ref,
      error: err instanceof Error ? err.message : String(err),
    })
    return { state: "unavailable", config: null }
  }
}

function jsonApiErrorResponse(status: number, title: string, detail?: string): Response {
  return new Response(
    JSON.stringify({
      errors: [
        {
          status: String(status),
          title,
          ...(detail ? { detail } : {}),
        },
      ],
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  )
}

function sensitivePublicOutputsError(outputNames: string[]): Response {
  const detail = `The public export includes sensitive Terraform outputs (${outputNames.join(", ")}). Store the secret in AWS Secrets Manager or SSM Parameter Store, output the ARN or name instead of the secret value, and grant the consuming workload IAM access to read it directly.`
  return jsonApiErrorResponse(422, "Sensitive outputs cannot be exported publicly", detail)
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
 * - environment: transient environment name to prefer over a named workspace
 */
registryRoute.get("/:namespace/:name/:provider/versions", async (c) => {
  const namespace = c.req.param("namespace")
  const moduleName = c.req.param("name")
  const provider = c.req.param("provider")
  const auth = c.get("tfcAuth")
  const environmentParam = c.req.query("environment")

  // Provider must be "yaffle" for our modules
  if (provider !== "yaffle") {
    return c.json(
      {
        errors: [{ status: "404", title: "Module not found", detail: "Provider must be 'yaffle'" }],
      },
      404,
    )
  }

  if (auth.type === "execution") {
    if (auth.repoNamespace !== namespace || !auth.repoBindingId || !auth.environmentName) {
      return c.json({ errors: [{ status: "404", title: "Module not found" }] }, 404)
    }

    const workspacePath = moduleNameToWorkspacePath(moduleName)
    const versions = await listHostedOutputModuleVersions({
      canonicalRepoNamespace: auth.repoNamespace,
      environmentName: auth.environmentName,
      workspacePath,
    })

    if (versions.length === 0) {
      return c.json({ errors: [{ status: "404", title: "Module not found" }] }, 404)
    }

    return c.json({
      modules: [
        {
          versions: versions.map((record) => ({
            version: buildHostedModuleVersion(record.versionSerial),
          })),
        },
      ],
    })
  }

  // Parse namespace into org and repo
  const parsed = parseNamespace(namespace)
  if (!parsed) {
    return c.json(
      {
        errors: [
          {
            status: "400",
            title: "Invalid namespace",
            detail: "Namespace must be in format: {org}--{repo}",
          },
        ],
      },
      400,
    )
  }
  const { orgSlug, repo } = parsed

  // Find the organization
  const org = await findOrgBySlug(orgSlug)
  if (!org) {
    return c.json({ errors: [{ status: "404", title: "Namespace not found" }] }, 404)
  }

  // Check org membership
  const membershipCheck = await checkOrgMembership(auth, org.id)
  if (!membershipCheck.allowed && "error" in membershipCheck) {
    return membershipCheck.error
  }

  // Convert module name to workspace path
  const workspacePath = moduleNameToWorkspacePath(moduleName)
  const consumerWorkspace = await resolveConsumerWorkspace(auth)
  const environmentDecision = deriveTransientEnvironment({
    explicitEnvironment: parseTransientEnvironmentContext(environmentParam ?? null),
    consumerWorkspace,
  })
  if (!environmentDecision.allowed) {
    return c.json({ errors: [{ status: "404", title: "Module not found" }] }, 404)
  }
  const transientEnvironment = environmentDecision.environment

  // Find the appropriate workspace
  let workspace: Workspace | undefined
  let stateVersions: Awaited<ReturnType<typeof listStateVersionsForModule>> = []
  let transientWorkspace: Workspace | undefined
  let transientStateVersions: Awaited<ReturnType<typeof listStateVersionsForModule>> | undefined

  if (transientEnvironment) {
    transientWorkspace = await findTransientWorkspace(
      org.id,
      repo,
      workspacePath,
      transientEnvironment.environmentName,
    )
    if (transientWorkspace) {
      transientStateVersions = await listStateVersionsForModule(transientWorkspace.id)

      if (transientStateVersions.length > 0) {
        workspace = transientWorkspace
        stateVersions = transientStateVersions
      } else {
        log.info(
          "Transient workspace has no finalized module versions, falling back to named workspace",
          {
            namespace,
            repo,
            workspacePath,
            environmentName: transientEnvironment.environmentName,
            workspaceId: transientWorkspace.id,
          },
        )
      }
    }
  }

  if (!workspace) {
    workspace = await findNamedWorkspace(org.id, repo, workspacePath)

    if (workspace) {
      stateVersions = await listStateVersionsForModule(workspace.id)
    } else if (transientWorkspace) {
      workspace = transientWorkspace
      stateVersions = transientStateVersions ?? []
    }
  }

  if (!workspace) {
    return c.json(
      {
        errors: [
          {
            status: "404",
            title: "Module not found",
            detail: `No workspace at path: ${workspacePath} in repo: ${repo}`,
          },
        ],
      },
      404,
    )
  }

  const producerConfigResult = await loadProducerConfig(workspace, orgSlug)

  const accessDecision = resolveModuleAccessDecision({
    authType: auth.type,
    producerWorkspace: workspace,
    producerConfigState: producerConfigResult.state,
    producerConfig: producerConfigResult.config,
    consumerWorkspace,
  })
  if (!accessDecision.allowed) {
    return jsonApiErrorResponse(
      accessDecision.errorStatus ?? 403,
      accessDecision.errorTitle ?? "Module access denied",
      accessDecision.errorDetail,
    )
  }

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
    isTransient: workspace.environmentKind === "transient",
  })

  // Return in Terraform module registry format
  return c.json({
    modules: [
      {
        versions,
      },
    ],
  })
})

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
 * - environment: transient environment name to prefer over a named workspace
 */
registryRoute.get("/:namespace/:name/:provider/:version/download", async (c) => {
  const namespace = c.req.param("namespace")
  const moduleName = c.req.param("name")
  const provider = c.req.param("provider")
  const version = c.req.param("version")
  const auth = c.get("tfcAuth")
  const environmentParam = c.req.query("environment")

  // Provider must be "yaffle"
  if (provider !== "yaffle") {
    return c.json({ errors: [{ status: "404", title: "Module not found" }] }, 404)
  }

  if (auth.type === "execution") {
    if (auth.repoNamespace !== namespace || !auth.repoBindingId || !auth.environmentName) {
      return c.json({ errors: [{ status: "404", title: "Module not found" }] }, 404)
    }

    const versionSerial = parseHostedModuleVersion(version)
    if (!versionSerial) {
      return c.json({ errors: [{ status: "400", title: "Invalid version format" }] }, 400)
    }

    const workspacePath = moduleNameToWorkspacePath(moduleName)
    const hostedModule = await findHostedOutputModuleVersion({
      canonicalRepoNamespace: auth.repoNamespace,
      environmentName: auth.environmentName,
      workspacePath,
      versionSerial,
    })

    if (!hostedModule) {
      return c.json({ errors: [{ status: "404", title: "Module not found" }] }, 404)
    }

    const archivePath = `/tfc/registry/v1/modules/${namespace}/${moduleName}/${provider}/${version}/archive.tar.gz`
    const token = signArchiveUrl(archivePath, {
      hostedOutputModuleId: hostedModule.id,
    })
    const params = new URLSearchParams({ token })
    const archiveUrl = `${archivePath}?${params.toString()}`

    return new Response(null, {
      status: 204,
      headers: {
        "X-Terraform-Get": archiveUrl,
      },
    })
  }

  // Parse namespace into org and repo
  const parsed = parseNamespace(namespace)
  if (!parsed) {
    return c.json(
      {
        errors: [
          {
            status: "400",
            title: "Invalid namespace",
            detail: "Namespace must be in format: {org}--{repo}",
          },
        ],
      },
      400,
    )
  }
  const { orgSlug, repo } = parsed

  // Find the organization
  const org = await findOrgBySlug(orgSlug)
  if (!org) {
    return c.json({ errors: [{ status: "404", title: "Namespace not found" }] }, 404)
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
    return c.json({ errors: [{ status: "400", title: "Invalid version format" }] }, 400)
  }

  // Convert module name to workspace path
  const workspacePath = moduleNameToWorkspacePath(moduleName)
  const consumerWorkspace = await resolveConsumerWorkspace(auth)
  const environmentDecision = deriveTransientEnvironment({
    explicitEnvironment: parseTransientEnvironmentContext(environmentParam ?? null),
    consumerWorkspace,
  })
  if (!environmentDecision.allowed) {
    return c.json({ errors: [{ status: "404", title: "Module not found" }] }, 404)
  }
  const transientEnvironment = environmentDecision.environment

  // Resolve the module
  const resolved = await resolveModule({
    orgId: org.id,
    repo,
    workspacePath,
    serial,
    transientEnvironment,
  })

  if (!resolved) {
    return c.json({ errors: [{ status: "404", title: "Module not found" }] }, 404)
  }

  const producerConfigResult = await loadProducerConfig(resolved.workspace, orgSlug)

  const accessDecision = resolveModuleAccessDecision({
    authType: auth.type,
    producerWorkspace: resolved.workspace,
    producerConfigState: producerConfigResult.state,
    producerConfig: producerConfigResult.config,
    consumerWorkspace,
  })
  if (!accessDecision.allowed) {
    return jsonApiErrorResponse(
      accessDecision.errorStatus ?? 403,
      accessDecision.errorTitle ?? "Module access denied",
      accessDecision.errorDetail,
    )
  }

  const filteredOutputs = filterOutputsForAccess(
    resolved.stateVersion.outputs as Record<string, unknown> | null,
    accessDecision.allowedOutputs,
  )
  const sensitivePublicOutputs = findSensitiveExportedOutputs(
    resolved.stateVersion.outputs as Record<string, unknown> | null,
    accessDecision.allowedOutputs,
  )
  if (sensitivePublicOutputs.length > 0) {
    return sensitivePublicOutputsError(sensitivePublicOutputs)
  }

  const canUseSharedArchive =
    accessDecision.allowedOutputs === null ||
    Object.keys(filteredOutputs ?? {}).length ===
      Object.keys((resolved.stateVersion.outputs as Record<string, unknown> | null) ?? {}).length

  log.info("Module download requested", {
    namespace,
    orgSlug,
    repo,
    moduleName,
    version,
    workspaceId: resolved.workspace.id,
    stateVersionId: resolved.stateVersion.id,
    serial: resolved.stateVersion.serial,
    isTransient: resolved.isTransient,
  })

  // Build archive URL with signed token
  const archivePath = `/tfc/registry/v1/modules/${namespace}/${moduleName}/${provider}/${version}/archive.tar.gz`
  const token = signArchiveUrl(archivePath, {
    stateVersionId: resolved.stateVersion.id,
    ...(canUseSharedArchive || !accessDecision.allowedOutputs
      ? {}
      : { outputNames: accessDecision.allowedOutputs }),
  })
  const params = new URLSearchParams({ token })
  const archiveUrl = `${archivePath}?${params.toString()}`

  return new Response(null, {
    status: 204,
    headers: {
      "X-Terraform-Get": archiveUrl,
    },
  })
})

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
 * - token: signed archive access token issued by the download endpoint
 */
registryRoute.get("/:namespace/:name/:provider/:version/archive.tar.gz", async (c) => {
  const namespace = c.req.param("namespace")
  const moduleName = c.req.param("name")
  const provider = c.req.param("provider")
  const version = c.req.param("version")
  const token = c.req.query("token")

  // Provider must be "yaffle"
  if (provider !== "yaffle") {
    return c.json({ errors: [{ status: "404", title: "Module not found" }] }, 404)
  }

  // Verify signed token (archive downloads don't have auth headers)
  const archivePath = `/tfc/registry/v1/modules/${namespace}/${moduleName}/${provider}/${version}/archive.tar.gz`
  const archiveToken = token ? verifyArchiveToken(archivePath, token) : null
  if (!archiveToken) {
    return c.json({ errors: [{ status: "401", title: "Invalid or expired token" }] }, 401)
  }

  if (archiveToken.hostedOutputModuleId) {
    const hostedModule = await findHostedOutputModuleById(archiveToken.hostedOutputModuleId)
    if (!hostedModule) {
      return c.json({ errors: [{ status: "404", title: "Module not found" }] }, 404)
    }

    const archive = await generateShimModule({
      workspacePath: hostedModule.workspacePath,
      serial: hostedModule.versionSerial,
      outputs: hostedModule.outputs as Record<string, unknown>,
    })

    return new Response(archive.buffer as ArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${moduleName}-${version}.tar.gz"`,
      },
    })
  }

  // Parse namespace into org and repo
  const parsed = parseNamespace(namespace)
  if (!parsed) {
    return c.json(
      {
        errors: [
          {
            status: "400",
            title: "Invalid namespace",
            detail: "Namespace must be in format: {org}--{repo}",
          },
        ],
      },
      400,
    )
  }
  const { orgSlug } = parsed

  // Find the organization
  const org = await findOrgBySlug(orgSlug)
  if (!org) {
    return c.json({ errors: [{ status: "404", title: "Namespace not found" }] }, 404)
  }

  // Token was verified, no need for membership check on archive download
  // (membership was checked when the download URL was generated)

  const stateVersionId = archiveToken.stateVersionId
  if (!stateVersionId) {
    return c.json({ errors: [{ status: "404", title: "Module not found" }] }, 404)
  }

  const stateVersion = await findStateVersionById(stateVersionId)
  if (!stateVersion || stateVersion.status !== "finalized") {
    return c.json({ errors: [{ status: "404", title: "Module not found" }] }, 404)
  }

  const workspace = await findWorkspaceById(stateVersion.workspaceId)
  if (!workspace || workspace.orgId !== org.id) {
    return c.json({ errors: [{ status: "404", title: "Module not found" }] }, 404)
  }

  const outputs = filterOutputsForAccess(
    stateVersion.outputs as Record<string, unknown> | null,
    archiveToken.outputNames ?? null,
  )

  const archive = archiveToken.outputNames
    ? await generateShimModule({
        workspacePath: workspace.workspacePath,
        serial: stateVersion.serial,
        outputs,
      })
    : await getOrGenerateModule(workspace.id, stateVersion.serial, org.id, async () =>
        generateShimModule({
          workspacePath: workspace.workspacePath,
          serial: stateVersion.serial,
          outputs,
        }),
      )

  log.info("Module archive served", {
    namespace,
    moduleName,
    version,
    workspaceId: workspace.id,
    stateVersionId: stateVersion.id,
    archiveSize: archive.length,
    filteredOutputCount: archiveToken.outputNames?.length,
  })

  return new Response(archive.buffer as ArrayBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${moduleName}-${version}.tar.gz"`,
    },
  })
})
