import { Hono } from "hono"

import { oauthCliRoute } from "./oauth-cli.ts"
import { workspacesRoute } from "./workspaces.ts"
import { stateVersionsRoute, stateUploadRoute } from "./state-versions.ts"
import { registryRoute } from "./registry.ts"

/**
 * TFC API version we claim to support.
 * The go-tfe client reads this from the TFP-API-Version header.
 * Terraform requires >= 2.5 for the cloud backend to work.
 *
 * @see https://github.com/hashicorp/go-tfe/blob/main/tfe.go
 */
const TFC_API_VERSION = "2.8"

/**
 * TFC-compatible API router.
 *
 * This namespace contains:
 * - OAuth endpoints for `terraform login` (/tfc/oauth/*)
 * - TFC API v2 endpoints (/tfc/api/v2/*)
 * - Module Registry v1 endpoints (/tfc/registry/v1/modules/*)
 *
 * All endpoints here implement (a subset of) the Terraform Cloud API
 * to enable native Terraform CLI integration.
 */
export const tfcRoute = new Hono()

// Middleware to add TFC API version headers to all responses
// The go-tfe client reads TFP-API-Version to check backend compatibility
tfcRoute.use("/api/v2/*", async (c, next) => {
  await next()
  c.header("TFP-API-Version", TFC_API_VERSION)
  // Force Content-Type to JSON:API spec - go-tfe expects this
  // BUT skip for state upload endpoint which emulates S3 blob storage
  // The upload endpoint returns empty body and shouldn't claim to be JSON
  if (!c.req.path.endsWith("/upload")) {
    c.header("Content-Type", "application/vnd.api+json")
  }
})

// OAuth endpoints for terraform login
tfcRoute.route("/oauth", oauthCliRoute)

// Ping endpoint for connectivity testing (no auth required)
// Must be defined BEFORE authenticated routes
tfcRoute.get("/api/v2/ping", (c) => {
  return c.json({ data: { type: "pings", id: "1" } })
})

// TFC API v2 - Workspaces
// Workspace routes handle both /organizations/:org/workspaces and /workspaces/:id patterns
tfcRoute.route("/api/v2", workspacesRoute)

// TFC API v2 - State Upload (unauthenticated)
// Must be registered BEFORE authenticated state-versions route.
// The upload URL acts like a presigned URL - no Bearer token required.
// Security is provided by the unpredictable UUID and one-time-use semantics.
tfcRoute.route("/api/v2", stateUploadRoute)

// TFC API v2 - State Versions (authenticated)
// State version routes handle workspace state management
tfcRoute.route("/api/v2", stateVersionsRoute)

// Module Registry v1
// Implements Terraform Module Registry Protocol for workspace-as-module consumption
// See: https://developer.hashicorp.com/terraform/internals/module-registry-protocol
tfcRoute.route("/registry/v1/modules", registryRoute)

// Re-export for convenience
export { oauthCliRoute, workspacesRoute, stateVersionsRoute, stateUploadRoute, registryRoute }
