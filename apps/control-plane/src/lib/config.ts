import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"

const CONFIG_PATH = ".yaffle/config.yml"

/**
 * Zod schema for .yaffle/config.yml
 */
const onApplySchema = z.object({
  /** Webhook URL to POST outputs to after successful apply */
  webhook: z.string().url().optional(),
  /** GitHub repository_dispatch event configuration */
  github_dispatch: z.object({
    repo: z.string().min(1),
    event: z.string().min(1).default("yaffle-apply"),
  }).optional(),
}).optional()

const workspaceSchema = z.object({
  path: z.string().min(1),
  auto_apply: z.boolean().default(true),
  auto_apply_on_merge: z.boolean().default(true),
  require_approval: z.boolean().default(false),
  approvers: z.array(z.string().min(1)).optional(),
  variables: z.record(z.string()).optional(),
  on_apply: onApplySchema,
})

const configSchema = z.object({
  version: z.literal(1),
  default_branch: z.string().optional(),
  workspaces: z.array(workspaceSchema).min(1, "at least one workspace is required"),
})

export { configSchema }
export type YaffleConfig = z.infer<typeof configSchema>
export type WorkspaceConfig = z.infer<typeof workspaceSchema>

/**
 * Validate a parsed YAML object against the config schema.
 * Throws ConfigError on invalid input.
 */
export function validateConfig(parsed: unknown): YaffleConfig {
  const result = configSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    throw new ConfigError(`Invalid .yaffle/config.yml:\n${issues.join("\n")}`)
  }
  return result.data
}

/**
 * Context available for variable interpolation.
 */
export interface VariableContext {
  /** "prvw-42" or "production" */
  env: string
  pr_number: string
  branch: string
  sha: string
  owner: string
  repo: string
}

/**
 * Load and validate .yaffle/config.yml from a workspace directory.
 * Throws if the config file is missing or invalid.
 */
export async function loadConfig(workDir: string): Promise<YaffleConfig> {
  const configPath = join(workDir, CONFIG_PATH)

  let raw: string
  try {
    raw = await readFile(configPath, "utf-8")
  } catch {
    throw new ConfigError(
      `No ${CONFIG_PATH} found. Yaffle requires a config file. See https://yaffle.dev/docs/config`,
    )
  }

  const parsed = parseYaml(raw)
  return validateConfig(parsed)
}

/**
 * Interpolate variable templates in a workspace's variables.
 * Replaces {{ name }} placeholders with values from the context.
 * Unknown placeholders are left as-is.
 *
 * Always injects `environment` from the context - this is a required
 * variable for all Yaffle-managed terraform workspaces.
 */
export function interpolateVariables(
  variables: Record<string, string> | undefined,
  ctx: VariableContext,
): Record<string, string> {
  // Always inject environment - it's required for all workspaces
  const result: Record<string, string> = {
    environment: ctx.env,
  }

  if (variables) {
    for (const [key, value] of Object.entries(variables)) {
      result[key] = interpolate(value, ctx)
    }
  }

  return result
}

/**
 * Replace {{ placeholder }} patterns in a string with context values.
 */
function interpolate(template: string, ctx: VariableContext): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => {
    if (name in ctx) {
      return ctx[name as keyof VariableContext]
    }
    // Unknown placeholder -- leave as-is
    return match
  })
}

/**
 * Build a VariableContext for a PR event.
 */
export function prVariableContext(opts: {
  prNumber: number
  branch: string
  sha: string
  owner: string
  repo: string
}): VariableContext {
  return {
    env: `prvw-${opts.prNumber}`,
    pr_number: String(opts.prNumber),
    branch: opts.branch,
    sha: opts.sha,
    owner: opts.owner,
    repo: opts.repo,
  }
}

/**
 * Build a VariableContext for a push-to-default-branch event.
 */
export function pushVariableContext(opts: {
  branch: string
  sha: string
  owner: string
  repo: string
}): VariableContext {
  return {
    env: "production",
    pr_number: "",
    branch: opts.branch,
    sha: opts.sha,
    owner: opts.owner,
    repo: opts.repo,
  }
}

/**
 * Minimal YAML parser for .yaffle/config.yml.
 *
 * We only need to handle simple key-value maps, arrays of objects,
 * and string/number/boolean values. This avoids pulling in a full
 * YAML library for a narrow, well-defined schema.
 */
export function parseYaml(input: string): unknown {
  const lines = input.split("\n")
  return parseObject(lines, 0).value
}

interface ParseResult {
  value: unknown
  nextLine: number
}

function parseObject(lines: string[], startLine: number, baseIndent = 0): ParseResult {
  const obj: Record<string, unknown> = {}
  let i = startLine

  while (i < lines.length) {
    const line = lines[i]

    // Skip empty lines and comments
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++
      continue
    }

    const indent = line.search(/\S/)
    if (indent < baseIndent) break // dedented, done with this object

    // Array item at this level
    if (line.trim().startsWith("- ")) {
      break // arrays are handled by the caller via parseArray
    }

    const keyMatch = line.match(/^(\s*)(\w[\w_]*):\s*(.*)$/)
    if (!keyMatch) {
      i++
      continue
    }

    const keyIndent = keyMatch[1].length
    if (keyIndent !== baseIndent) break

    const key = keyMatch[2]
    const inlineValue = keyMatch[3].trim()

    if (inlineValue === "") {
      // Check what's on the next meaningful line
      const nextMeaningful = findNextMeaningfulLine(lines, i + 1)
      if (nextMeaningful < lines.length) {
        const nextLine = lines[nextMeaningful]
        const nextIndent = nextLine.search(/\S/)
        if (nextIndent > baseIndent && nextLine.trim().startsWith("- ")) {
          const arr = parseArray(lines, nextMeaningful, nextIndent)
          obj[key] = arr.value
          i = arr.nextLine
          continue
        } else if (nextIndent > baseIndent) {
          const nested = parseObject(lines, nextMeaningful, nextIndent)
          obj[key] = nested.value
          i = nested.nextLine
          continue
        }
      }
      obj[key] = null
      i++
    } else {
      obj[key] = parseScalar(inlineValue)
      i++
    }
  }

  return { value: obj, nextLine: i }
}

function parseArray(lines: string[], startLine: number, baseIndent: number): ParseResult {
  const arr: unknown[] = []
  let i = startLine

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++
      continue
    }

    const indent = line.search(/\S/)
    if (indent < baseIndent) break
    if (!line.trim().startsWith("- ")) break

    // Strip the "- " prefix and parse the item
    const afterDash = line.substring(indent + 2)
    const itemMatch = afterDash.match(/^(\w[\w_]*):\s*(.*)$/)

    if (itemMatch) {
      // Array item is an object. Parse first key from this line,
      // then continue parsing nested keys at deeper indent.
      const firstKey = itemMatch[1]
      const firstValue = itemMatch[2].trim()
      const itemIndent = indent + 2

      const item: Record<string, unknown> = {}
      item[firstKey] = firstValue === "" ? null : parseScalar(firstValue)

      // Parse remaining keys of this object
      const nested = parseObject(lines, i + 1, itemIndent)
      Object.assign(item, nested.value)
      arr.push(item)
      i = nested.nextLine
    } else {
      // Simple scalar array item
      arr.push(parseScalar(afterDash.trim()))
      i++
    }
  }

  return { value: arr, nextLine: i }
}

function findNextMeaningfulLine(lines: string[], startLine: number): number {
  let i = startLine
  while (i < lines.length) {
    const trimmed = lines[i].trim()
    if (trimmed !== "" && !trimmed.startsWith("#")) return i
    i++
  }
  return i
}

function parseScalar(value: string): string | number | boolean | null {
  // Remove inline comments
  const commentIdx = value.indexOf(" #")
  const clean = commentIdx >= 0 ? value.substring(0, commentIdx).trim() : value

  // Quoted string
  if ((clean.startsWith('"') && clean.endsWith('"')) ||
      (clean.startsWith("'") && clean.endsWith("'"))) {
    return clean.slice(1, -1)
  }

  // Boolean
  if (clean === "true") return true
  if (clean === "false") return false

  // Null
  if (clean === "null" || clean === "~") return null

  // Number
  const num = Number(clean)
  if (!Number.isNaN(num) && clean !== "") return num

  // Bare string
  return clean
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
  }
}
