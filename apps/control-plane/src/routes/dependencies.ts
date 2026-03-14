import { Hono } from "hono"

import { parseYaffleToml } from "../lib/config-toml.ts"
import { DependencyGraph } from "../lib/dependency-graph.ts"
import { requireOrgAccess, type OrgAuthContext } from "../middleware/org-auth.ts"

// Hono context with org auth
type Variables = {
  auth: OrgAuthContext
}

/**
 * Build a minimal dependency graph from TOML config.
 *
 * TOML config doesn't have explicit dependency declarations - dependencies
 * are inferred at runtime by scanning module references. This function
 * returns a graph with workspaces but no edges.
 */
function buildGraphFromTomlConfig(config: ReturnType<typeof parseYaffleToml>): DependencyGraph {
  const graph = new DependencyGraph()
  for (const ws of config.workspaces) {
    // Add workspace as an isolated node (no dependencies, those are inferred at runtime)
    graph.addIsolatedNode(ws.path)
  }
  return graph
}

/**
 * Validate TOML config graph. Always returns valid since dependencies are inferred.
 */
function validateTomlGraph(_graph: DependencyGraph): { valid: true; errors: never[] } {
  return { valid: true, errors: [] }
}

/**
 * Dependency graph API endpoints.
 *
 * These endpoints provide information about workspace dependencies.
 * Dependencies are inferred at runtime by scanning module references.
 *
 * All endpoints require org membership and accept TOML config in request body.
 */
export const dependenciesRoute = new Hono<{ Variables: Variables }>()

/**
 * POST /api/orgs/:org/dependencies/validate
 *
 * Validate a yaffle.toml configuration.
 * Returns validation errors (cycles, denied consumers, etc.).
 *
 * Note: Dependencies are inferred at runtime, so this endpoint
 * only validates config syntax. Cycle detection happens during
 * webhook processing.
 *
 * Request body: { config: string } (TOML content)
 */
dependenciesRoute.post(
  "/orgs/:org/dependencies/validate",
  requireOrgAccess({ orgSource: "param", orgKey: "org" }),
  async (c) => {
    // Parse request body
    const body = await c.req.json<{ config: string }>()
    if (!body.config) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Missing config field" } }, 400)
    }

    try {
      // Parse config (validates syntax and semantic rules)
      const config = parseYaffleToml(body.config)

      // Build minimal graph (no explicit dependencies in TOML)
      const graph = buildGraphFromTomlConfig(config)

      // Validate (always valid for TOML since dependencies are inferred)
      const result = validateTomlGraph(graph)

      return c.json({
        data: {
          valid: result.valid,
          errors: result.errors,
        },
      })
    } catch (err) {
      return c.json(
        {
          error: {
            code: "INVALID_CONFIG",
            message: err instanceof Error ? err.message : "Invalid config",
          },
        },
        400,
      )
    }
  },
)

/**
 * POST /api/orgs/:org/dependencies/graph
 *
 * Build and return the dependency graph for a configuration.
 *
 * Note: TOML config doesn't have explicit dependencies. The graph
 * returned here only shows workspaces. Actual dependencies are
 * inferred at runtime by scanning module references.
 *
 * Request body: { config: string } (TOML content)
 */
dependenciesRoute.post(
  "/orgs/:org/dependencies/graph",
  requireOrgAccess({ orgSource: "param", orgKey: "org" }),
  async (c) => {
    // Parse request body
    const body = await c.req.json<{ config: string }>()
    if (!body.config) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Missing config field" } }, 400)
    }

    try {
      // Parse config
      const config = parseYaffleToml(body.config)

      // Build minimal graph (no explicit dependencies in TOML)
      const graph = buildGraphFromTomlConfig(config)

      // Validate (always valid for TOML)
      const validation = validateTomlGraph(graph)

      // Get topological order (all workspaces in config order since no deps)
      const topologicalOrder = config.workspaces.map((ws) => ws.path)

      return c.json({
        data: {
          ...graph.toJSON(),
          validation,
          topologicalOrder,
        },
      })
    } catch (err) {
      return c.json(
        {
          error: {
            code: "INVALID_CONFIG",
            message: err instanceof Error ? err.message : "Invalid config",
          },
        },
        400,
      )
    }
  },
)

/**
 * POST /api/orgs/:org/dependencies/workspace/:path/dependencies
 *
 * Get direct dependencies for a specific workspace.
 *
 * Note: TOML config doesn't have explicit dependencies. This endpoint
 * returns an empty array. Actual dependencies are inferred at runtime.
 *
 * Request body: { config: string } (TOML content)
 * Path parameter: workspace path (URL encoded, use -- for /)
 */
dependenciesRoute.post(
  "/orgs/:org/dependencies/workspace/:path/dependencies",
  requireOrgAccess({ orgSource: "param", orgKey: "org" }),
  async (c) => {
    // Workspace path uses -- as separator in URL
    const pathParam = c.req.param("path")
    if (!pathParam) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Missing path parameter" } }, 400)
    }
    const workspacePath = pathParam.replace(/--/g, "/")

    // Parse request body
    const body = await c.req.json<{ config: string }>()
    if (!body.config) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Missing config field" } }, 400)
    }

    try {
      // Validate config (but we don't extract dependencies from it)
      parseYaffleToml(body.config)

      // TOML doesn't have explicit dependencies - they're inferred at runtime
      return c.json({
        data: {
          workspace: workspacePath,
          dependencies: [],
          note: "Dependencies are inferred at runtime from module references",
        },
      })
    } catch (err) {
      return c.json(
        {
          error: {
            code: "INVALID_CONFIG",
            message: err instanceof Error ? err.message : "Invalid config",
          },
        },
        400,
      )
    }
  },
)

/**
 * POST /api/orgs/:org/dependencies/workspace/:path/dependents
 *
 * Get workspaces that depend on a specific workspace (blast radius).
 *
 * Note: TOML config doesn't have explicit dependencies. This endpoint
 * returns empty arrays. Actual dependents are inferred at runtime.
 *
 * Request body: { config: string } (TOML content)
 * Path parameter: workspace path (URL encoded, use -- for /)
 */
dependenciesRoute.post(
  "/orgs/:org/dependencies/workspace/:path/dependents",
  requireOrgAccess({ orgSource: "param", orgKey: "org" }),
  async (c) => {
    // Workspace path uses -- as separator in URL
    const pathParam = c.req.param("path")
    if (!pathParam) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Missing path parameter" } }, 400)
    }
    const workspacePath = pathParam.replace(/--/g, "/")

    // Parse request body
    const body = await c.req.json<{ config: string }>()
    if (!body.config) {
      return c.json({ error: { code: "BAD_REQUEST", message: "Missing config field" } }, 400)
    }

    try {
      // Validate config (but we don't extract dependencies from it)
      parseYaffleToml(body.config)

      // TOML doesn't have explicit dependencies - they're inferred at runtime
      return c.json({
        data: {
          workspace: workspacePath,
          directDependents: [],
          transitiveDependents: [],
          blastRadius: 0,
          note: "Dependencies are inferred at runtime from module references",
        },
      })
    } catch (err) {
      return c.json(
        {
          error: {
            code: "INVALID_CONFIG",
            message: err instanceof Error ? err.message : "Invalid config",
          },
        },
        400,
      )
    }
  },
)
