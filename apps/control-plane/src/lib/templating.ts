/**
 * Template rendering for workspace variables using MiniJinja.
 *
 * This module provides a thin wrapper around minijinja-js for rendering
 * template expressions in workspace variable values.
 *
 * Template context includes:
 * - environment: Environment name (e.g., "main", "pr-123")
 * - environment_kind: "named" or "transient"
 * - org: GitHub organization/owner name
 * - repo: Repository name (without owner prefix)
 * - workspace_path: Path to workspace (e.g., "infra/production")
 * - branch: Git branch name
 * - commit_sha: Full commit SHA
 * - pr_number: GitHub PR number (null for every other source)
 */

import { Environment } from "minijinja-js"

/**
 * Context available to all template expressions.
 */
export interface TemplateContext {
  /** Environment name (e.g., "main", "staging", "pr-123") */
  environment: string
  /** Whether this is a named or transient environment */
  environment_kind: "named" | "transient"
  /** GitHub organization/owner name */
  org: string
  /** Repository name (without owner prefix) */
  repo: string
  /** Workspace path (e.g., "infra/production") */
  workspace_path: string
  /** Git branch name */
  branch: string
  /** Full commit SHA */
  commit_sha: string
  /** GitHub PR number or null for every other source */
  pr_number: number | null
}

/**
 * Error thrown when template rendering fails.
 */
export class TemplateError extends Error {
  constructor(
    message: string,
    public readonly template: string,
    public readonly workspacePath: string,
    public readonly variableName: string,
  ) {
    super(message)
    this.name = "TemplateError"
  }
}

// Singleton environment instance
let _env: Environment | null = null

function getEnvironment(): Environment {
  if (!_env) {
    _env = new Environment()
    // Enable strict mode to error on undefined variables
    _env.undefinedBehavior = "strict"
  }
  return _env
}

/**
 * Render a single template string with the given context.
 *
 * @param template - Template string (e.g., "{{ environment }}.yaffle.dev")
 * @param context - Template context
 * @param meta - Metadata for error reporting
 * @returns Rendered string
 * @throws TemplateError on syntax error or undefined variable
 */
export function renderTemplate(
  template: string,
  context: TemplateContext,
  meta: { workspacePath: string; variableName: string },
): string {
  // If the template contains no template syntax, return as-is
  if (!template.includes("{{") && !template.includes("{%")) {
    return template
  }

  const env = getEnvironment()

  try {
    return env.renderStr(template, context)
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    throw new TemplateError(
      `Failed to render template for variable "${meta.variableName}" in workspace "${meta.workspacePath}": ${errorMessage}`,
      template,
      meta.workspacePath,
      meta.variableName,
    )
  }
}

/**
 * Render all string variable values in a variables object.
 * Non-string values (boolean, number) are passed through unchanged.
 *
 * @param variables - Variables object from workspace config
 * @param context - Template context
 * @param workspacePath - Workspace path for error reporting
 * @returns New variables object with rendered strings
 * @throws TemplateError on any template rendering failure
 */
export function renderVariables(
  variables: Record<string, string | number | boolean>,
  context: TemplateContext,
  workspacePath: string,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {}

  for (const [key, value] of Object.entries(variables)) {
    if (typeof value === "string") {
      result[key] = renderTemplate(value, context, {
        workspacePath,
        variableName: key,
      })
    } else {
      // Pass through numbers and booleans unchanged
      result[key] = value
    }
  }

  return result
}
