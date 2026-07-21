/**
 * Approver parsing and authorization.
 *
 * Approvers use a namespaced format: `<provider>:<type>:<identifier>`
 *
 * Supported formats:
 * - `github:user:<username>` - GitHub user
 * - `github:team:<org>/<team>` - GitHub team
 *
 * All identifiers are normalized to lowercase.
 */

import { checkTeamMembership as checkTeamMembershipImpl } from "./github.ts"

// =============================================================================
// Types
// =============================================================================

/** Supported approver providers */
export type ApproverProvider = "github"

/** GitHub user approver */
export interface GitHubUserApprover {
  provider: "github"
  type: "user"
  username: string // lowercase
}

/** GitHub team approver */
export interface GitHubTeamApprover {
  provider: "github"
  type: "team"
  org: string // lowercase
  team: string // lowercase
}

/** Union of all approver types */
export type Approver = GitHubUserApprover | GitHubTeamApprover

// =============================================================================
// Errors
// =============================================================================

/** Error thrown when parsing an invalid approver string */
export class ApproverParseError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message)
    this.name = "ApproverParseError"
  }
}

// =============================================================================
// Parsing
// =============================================================================

/**
 * Parse an approver string into a typed Approver object.
 *
 * @param raw - Raw approver string (e.g., "github:user:alice")
 * @returns Parsed and normalized Approver
 * @throws ApproverParseError on invalid format
 */
export function parseApprover(raw: string): Approver {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new ApproverParseError("Approver string cannot be empty", raw)
  }

  const parts = trimmed.split(":")
  if (parts.length < 3) {
    throw new ApproverParseError(
      `Invalid approver format: expected "<provider>:<type>:<identifier>", got "${raw}"`,
      raw,
    )
  }

  const [provider, type, ...rest] = parts
  const identifier = rest.join(":") // Rejoin in case identifier contains colons

  if (!provider) {
    throw new ApproverParseError(`Missing provider in approver: "${raw}"`, raw)
  }

  if (!type) {
    throw new ApproverParseError(`Missing type in approver: "${raw}"`, raw)
  }

  if (!identifier) {
    throw new ApproverParseError(`Missing identifier in approver: "${raw}"`, raw)
  }

  // Dispatch to provider-specific parser
  switch (provider.toLowerCase()) {
    case "github":
      return parseGitHubApprover(type, identifier, raw)
    default:
      throw new ApproverParseError(
        `Unknown approver provider "${provider}". Supported: github`,
        raw,
      )
  }
}

/**
 * Parse a GitHub approver (user or team).
 */
function parseGitHubApprover(type: string, identifier: string, raw: string): Approver {
  switch (type.toLowerCase()) {
    case "user":
      return parseGitHubUserApprover(identifier, raw)
    case "team":
      return parseGitHubTeamApprover(identifier, raw)
    default:
      throw new ApproverParseError(
        `Unknown GitHub approver type "${type}". Supported: user, team`,
        raw,
      )
  }
}

/**
 * Parse a GitHub user approver.
 */
function parseGitHubUserApprover(username: string, raw: string): GitHubUserApprover {
  const normalized = username.toLowerCase().trim()
  if (!normalized) {
    throw new ApproverParseError(`Empty username in GitHub user approver: "${raw}"`, raw)
  }

  // Basic validation: GitHub usernames can't contain slashes
  if (normalized.includes("/")) {
    throw new ApproverParseError(
      `Invalid GitHub username "${username}": usernames cannot contain "/"`,
      raw,
    )
  }

  return {
    provider: "github",
    type: "user",
    username: normalized,
  }
}

/**
 * Parse a GitHub team approver.
 */
function parseGitHubTeamApprover(identifier: string, raw: string): GitHubTeamApprover {
  const slashIndex = identifier.indexOf("/")
  if (slashIndex === -1) {
    throw new ApproverParseError(
      `Invalid GitHub team format: expected "org/team", got "${identifier}"`,
      raw,
    )
  }

  const org = identifier.slice(0, slashIndex).toLowerCase().trim()
  const team = identifier
    .slice(slashIndex + 1)
    .toLowerCase()
    .trim()

  if (!org) {
    throw new ApproverParseError(`Empty org in GitHub team approver: "${raw}"`, raw)
  }

  if (!team) {
    throw new ApproverParseError(`Empty team in GitHub team approver: "${raw}"`, raw)
  }

  return {
    provider: "github",
    type: "team",
    org,
    team,
  }
}

// =============================================================================
// Serialization
// =============================================================================

/**
 * Serialize an Approver back to its string representation.
 */
export function serializeApprover(approver: Approver): string {
  switch (approver.provider) {
    case "github":
      if (approver.type === "user") {
        return `github:user:${approver.username}`
      } else {
        return `github:team:${approver.org}/${approver.team}`
      }
  }
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Check if a string is a valid approver format.
 * For use in Zod refinements.
 */
export function isValidApproverString(raw: string): boolean {
  try {
    parseApprover(raw)
    return true
  } catch {
    return false
  }
}

/**
 * Get a validation error message for an invalid approver string.
 * Returns undefined if the string is valid.
 */
export function getApproverValidationError(raw: string): string | undefined {
  try {
    parseApprover(raw)
    return undefined
  } catch (err) {
    if (err instanceof ApproverParseError) {
      return err.message
    }
    return `Invalid approver format: "${raw}"`
  }
}

// =============================================================================
// Authorization
// =============================================================================

/** Context for authorization checks */
export interface ApproverAuthContext {
  /** GitHub username of the user attempting to approve (lowercase) */
  githubUsername: string
  /** GitHub App installation ID for API calls */
  installationId: number
}

/** Function type for team membership checking (for dependency injection) */
export type TeamMembershipChecker = (
  installationId: number,
  org: string,
  team: string,
  username: string,
) => Promise<boolean>

/** Default team membership checker using GitHub API */
const defaultTeamMembershipChecker: TeamMembershipChecker = checkTeamMembershipImpl

/**
 * Check if a user is authorized by a single approver.
 *
 * @param approver - Parsed approver object
 * @param context - Authorization context
 * @param checkTeamMembership - Optional team membership checker (for testing)
 * @returns true if the user matches this approver
 */
export async function checkApprover(
  approver: Approver,
  context: ApproverAuthContext,
  checkTeamMembership: TeamMembershipChecker = defaultTeamMembershipChecker,
): Promise<boolean> {
  switch (approver.provider) {
    case "github":
      return checkGitHubApprover(approver, context, checkTeamMembership)
  }
}

/**
 * Check if a user matches a GitHub approver.
 */
async function checkGitHubApprover(
  approver: GitHubUserApprover | GitHubTeamApprover,
  context: ApproverAuthContext,
  checkTeamMembership: TeamMembershipChecker,
): Promise<boolean> {
  if (approver.type === "user") {
    // Simple username comparison (both already lowercase)
    return approver.username === context.githubUsername.toLowerCase()
  } else {
    // Team membership check via GitHub API
    return checkTeamMembership(
      context.installationId,
      approver.org,
      approver.team,
      context.githubUsername,
    )
  }
}

/**
 * Check if a user is authorized by any of the approvers.
 *
 * @param approverStrings - Array of raw approver strings
 * @param context - Authorization context
 * @param checkTeamMembership - Optional team membership checker (for testing)
 * @returns true if the user matches any approver
 */
export async function isUserAuthorizedApprover(
  approverStrings: string[],
  context: ApproverAuthContext,
  checkTeamMembership: TeamMembershipChecker = defaultTeamMembershipChecker,
): Promise<boolean> {
  if (approverStrings.length === 0) {
    // No approvers configured = anyone can approve
    return true
  }

  // Parse all approvers first (fail fast on invalid format)
  const approvers = approverStrings.map(parseApprover)

  // Check each approver - return true on first match
  for (const approver of approvers) {
    const authorized = await checkApprover(approver, context, checkTeamMembership)
    if (authorized) {
      return true
    }
  }

  return false
}

// =============================================================================
// Display Helpers
// =============================================================================

/** Approver display info for UI rendering */
export interface ApproverDisplay {
  /** Display label (e.g., "@alice" or "platform-engineering") */
  label: string
  /** URL to link to (e.g., GitHub profile or team page) */
  url: string
  /** Icon type for rendering */
  iconType: "user" | "team"
  /** Provider name for attribution */
  provider: string
}

/**
 * Get display info for an approver.
 */
export function getApproverDisplay(approver: Approver): ApproverDisplay {
  switch (approver.provider) {
    case "github":
      if (approver.type === "user") {
        return {
          label: `@${approver.username}`,
          url: `https://github.com/${approver.username}`,
          iconType: "user",
          provider: "GitHub",
        }
      } else {
        return {
          label: `${approver.org}/${approver.team}`,
          url: `https://github.com/orgs/${approver.org}/teams/${approver.team}`,
          iconType: "team",
          provider: "GitHub",
        }
      }
  }
}

/**
 * Parse and get display info for an approver string.
 * Returns undefined if parsing fails.
 */
export function getApproverDisplayFromString(raw: string): ApproverDisplay | undefined {
  try {
    const approver = parseApprover(raw)
    return getApproverDisplay(approver)
  } catch {
    return undefined
  }
}
