import { Hono } from "hono"

import {
  parseYaffleConfig,
  buildDependencyGraphFromConfig,
  validateDependencyGraph,
  getWorkspaceDependencies,
} from "../lib/config-parser.ts"
import { requireOrgAccess, type OrgAuthContext } from "../middleware/org-auth.ts"

// Hono context with org auth
type Variables = {
  auth: OrgAuthContext
}

/**
 * Dependency graph API endpoints.
 *
 * These endpoints provide information about workspace dependencies
 * as declared in .yaffle/config.yml.
 *
 * All endpoints require org membership and accept YAML config in request body.
 */
export const dependenciesRoute = new Hono<{ Variables: Variables }>()

/**
 * POST /api/orgs/:org/dependencies/validate
 *
 * Validate a .yaffle/config.yml configuration.
 * Returns validation errors (cycles, denied consumers, etc.).
 *
 * Request body: { config: string } (YAML content)
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
      // Parse config
      const config = parseYaffleConfig(body.config)

      // Build dependency graph
      const graph = buildDependencyGraphFromConfig(config)

      // Validate
      const result = validateDependencyGraph(graph)

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
 * Request body: { config: string } (YAML content)
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
      const config = parseYaffleConfig(body.config)

      // Build dependency graph
      const graph = buildDependencyGraphFromConfig(config)

      // Validate first
      const validation = validateDependencyGraph(graph)

      // Get topological order (null if there's a cycle)
      const topologicalOrder = validation.valid ? graph.getTopologicalOrder() : null

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
 * Request body: { config: string } (YAML content)
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
      const config = parseYaffleConfig(body.config)
      const dependencies = getWorkspaceDependencies(config, workspacePath)

      return c.json({
        data: {
          workspace: workspacePath,
          dependencies,
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
 * Request body: { config: string } (YAML content)
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
      const config = parseYaffleConfig(body.config)
      const graph = buildDependencyGraphFromConfig(config)

      const directDependents = graph.getDependents(workspacePath)
      const transitiveDependents = graph.getTransitiveDependents(workspacePath)

      return c.json({
        data: {
          workspace: workspacePath,
          directDependents,
          transitiveDependents,
          blastRadius: transitiveDependents.length,
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
