import { Hono } from "hono"

/**
 * Service discovery endpoint for Terraform CLI.
 * See: https://developer.hashicorp.com/terraform/internals/remote-service-discovery
 */
export const wellKnownRoute = new Hono()

/**
 * GET /.well-known/terraform.json
 *
 * Returns service discovery information for Terraform CLI.
 * The CLI uses this to find:
 * - API endpoints (tfe.v2, tfe.v2.1, tfe.v2.2)
 * - OAuth endpoints for `terraform login`
 */
wellKnownRoute.get("/terraform.json", (c) => {
  // Use relative URLs so it works on any hostname (localhost, preview envs, production)
  return c.json({
    // TFC-compatible API versions - all point to /tfc/api/v2/
    "tfe.v2": "/tfc/api/v2/",
    "tfe.v2.1": "/tfc/api/v2/",
    "tfe.v2.2": "/tfc/api/v2/",

    // Module registry protocol
    // See: https://developer.hashicorp.com/terraform/internals/module-registry-protocol
    "modules.v1": "/tfc/registry/v1/modules/",

    // OAuth configuration for `terraform login`
    "login.v1": {
      // Client ID - advisory only since Terraform CLI is a public client
      client: "terraform-cli",

      // Only authorization code grant with PKCE
      grant_types: ["authz_code"],

      // OAuth endpoints (under /tfc/ namespace)
      authz: "/tfc/oauth/authorize",
      token: "/tfc/oauth/token",

      // Allowed ports for CLI's localhost redirect
      // Terraform CLI will try ports in this range for its callback server
      ports: [10000, 10010],
    },
  })
})
