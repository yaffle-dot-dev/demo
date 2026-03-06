import { Hono } from "hono"

import { oauthCliRoute } from "./oauth-cli.ts"
import { workspacesRoute } from "./workspaces.ts"
import { stateVersionsRoute } from "./state-versions.ts"

/**
 * TFC-compatible API router.
 *
 * This namespace contains:
 * - OAuth endpoints for `terraform login` (/tfc/oauth/*)
 * - TFC API v2 endpoints (/tfc/api/v2/*)
 *
 * All endpoints here implement (a subset of) the Terraform Cloud API
 * to enable native Terraform CLI integration.
 */
export const tfcRoute = new Hono()

// OAuth endpoints for terraform login
tfcRoute.route("/oauth", oauthCliRoute)

// TFC API v2 - Workspaces
// Workspace routes handle both /organizations/:org/workspaces and /workspaces/:id patterns
tfcRoute.route("/api/v2", workspacesRoute)

// TFC API v2 - State Versions
// State version routes handle workspace state management
tfcRoute.route("/api/v2", stateVersionsRoute)

// Ping endpoint for connectivity testing
tfcRoute.get("/api/v2/ping", (c) => {
  return c.json({ data: { type: "pings", id: "1" } })
})

// Re-export for convenience
export { oauthCliRoute, workspacesRoute, stateVersionsRoute }
