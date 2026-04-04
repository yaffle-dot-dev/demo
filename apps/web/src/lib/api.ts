const API_BASE = "/api"

export interface Preview {
  id: string
  repo: string
  prNumber: number
  workspacePath: string
  ref: string
  headSha: string
  /** GitHub user ID (stable identifier for matching) */
  authorGithubId: number | null
  /** GitHub username (for display, can change) */
  authorLogin: string | null
  status: string
  stateKey: string
  mode: string
  requireApproval: boolean
  approvers: string[] | null
  createdAt: string
}

export interface Run {
  id: string
  previewId: string
  runGroupId: string | null
  runType: string
  status: string
  checkRunId: number | null
  planSummary: string | null
  outputs: unknown
  errorMessage: string | null
  logOutput?: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  durationMs?: number | null
}

/**
 * Dependency graph for workspace execution order.
 * Edges are [source, target] tuples where source depends on target.
 */
export interface DependencyGraph {
  workspaces: string[]
  edges: [string, string][]
}

export interface SystemErrorLine {
  lineNumber: number
  text: string
  highlight: boolean
}

export interface RunGroupSystemError {
  kind: "config"
  title: string
  summary: string
  filePath: string
  line: number | null
  column: number | null
  excerpt: SystemErrorLine[]
}

export interface RunGroup {
  id: string
  repo: string
  prNumber: number | null
  ref: string
  headSha: string
  trigger: string
  status: string
  /** Inferred dependency graph for this run group */
  dependencyGraph: DependencyGraph | null
  systemError: RunGroupSystemError | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface ListResponse<T> {
  data: T[]
  nextCursor: string | null
}

export interface DetailResponse<T> {
  data: T
}

export interface ApiError {
  error: { code: string; message: string }
}

export interface EnvironmentWorkspace {
  previewId: string
  workspacePath: string
  status: string
  connectionStatus: "ready" | "missing" | "conflict" | "not_required"
  missingProviders: string[]
  conflictProviders: string[]
  matchedConnections: Array<{ id: string; name: string; provider: string }>
  blockedReason: string | null
  headSha: string
  lastRunId: string | null
  lastRunType: string | null
  lastRunStatus: string | null
  lastRunCompletedAt: string | null
  planSummary: string | null
}

export interface EnvironmentGroup {
  repo: string
  ref: string
  environmentName: string
  headSha: string
  status: string
  updatedAt: string
  workspaces: EnvironmentWorkspace[]
}

export interface OrgInfo {
  id: string
  name: string
  slug: string
  role: string
  source: string
}

export interface OrgConnection {
  id: string
  name: string
  type: string
  providerType: string | null
  credentialProviderType: string | null
  config: unknown
  secretStore: string | null
  secretPath: string | null
  secretArn: string
  lastValidatedAt: string | null
  lastValidationError: string | null
  createdAt: string
  updatedAt: string
}

export interface OrgConnectionDetail {
  id: string
  name: string
  providerType: string | null
  credentialProviderType: string | null
  config: Record<string, unknown>
  secret: unknown
}

// Compact preview shape for grouped views (less fields than full Preview)
export interface WorkspacePreview {
  id: string
  workspacePath: string
  status: string
  connectionStatus: "ready" | "missing" | "conflict" | "not_required"
  missingProviders: string[]
  conflictProviders: string[]
  matchedConnections: Array<{ id: string; name: string; provider: string }>
  blockedReason: string | null
  stateKey: string
  mode: string
  requireApproval: boolean
  createdAt: string
}

export interface ResourceSpan {
  id: string
  resourceAddress: string
  resourceType: string | null
  action: string
  status: string        // started | complete | error
  startedAt: string
  completedAt: string | null
  durationMs: number | null
}

export interface WorkspaceWithRuns {
  preview: WorkspacePreview
  runs: Run[]
  outputs: unknown | null
  resourceSpans?: ResourceSpan[]
}

export interface PrPreviewGroup {
  org: string
  repo: string
  prNumber: number
  ref: string
  headSha: string
  authorLogin: string | null
  workspaces: WorkspaceWithRuns[]
  runGroups: RunGroup[]
}

export interface EnvPreviewGroup {
  org: string
  repo: string
  ref: string
  headSha: string
  workspaces: WorkspaceWithRuns[]
  runGroups: RunGroup[]
}

/**
 * Unified environment preview group (replaces both PrPreviewGroup and EnvPreviewGroup).
 * Used with the new /environment/:name endpoint.
 */
export interface EnvironmentPreviewGroup {
  org: string
  repo: string
  environmentKind: "named" | "transient"
  environmentName: string
  ref: string
  headSha: string
  prNumber: number | null
  authorGithubId: number | null
  authorLogin: string | null
  workspaces: WorkspaceWithRuns[]
  runGroups: RunGroup[]
}

export interface PreviewOverviewResponse {
  data: Preview[]
  dependencyGraphs: Record<string, DependencyGraph>
  nextCursor: string | null
}

async function fetchJson<T>(path: string): Promise<T> {
  // BetterAuth uses cookies for authentication, sent automatically by the browser
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
  })
  const text = await res.text()
  if (!res.ok) {
    try {
      const body = JSON.parse(text) as ApiError
      throw new Error(body.error?.message ?? `API error: ${res.status}`)
    } catch {
      throw new Error(`API error: ${res.status}`)
    }
  }

  if (!text) {
    throw new Error("API returned an empty response")
  }

  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error("API returned non-JSON data")
  }
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) {
    try {
      const parsed = JSON.parse(text) as ApiError
      throw new Error(parsed.error?.message ?? `API error: ${res.status}`)
    } catch {
      throw new Error(text || `API error: ${res.status}`)
    }
  }

  if (!text) {
    return undefined as T
  }

  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error("API returned non-JSON data")
  }
}

async function deleteJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    credentials: "include",
  })
  const text = await res.text()
  if (!res.ok) {
    try {
      const parsed = JSON.parse(text) as ApiError
      throw new Error(parsed.error?.message ?? `API error: ${res.status}`)
    } catch {
      throw new Error(text || `API error: ${res.status}`)
    }
  }

  if (!text) {
    return undefined as T
  }

  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error("API returned non-JSON data")
  }
}

export async function listPreviews(params: {
  org: string
  repo?: string
  status?: string
  prNumber?: number
  limit?: number
  cursor?: string
}): Promise<ListResponse<Preview>> {
  const searchParams = new URLSearchParams()
  searchParams.set("org", params.org)
  if (params.repo) searchParams.set("repo", params.repo)
  if (params.status) searchParams.set("status", params.status)
  if (params.prNumber) searchParams.set("pr_number", String(params.prNumber))
  if (params.limit) searchParams.set("limit", String(params.limit))
  if (params.cursor) searchParams.set("cursor", params.cursor)

  return fetchJson(`/previews?${searchParams}`)
}

export async function listEnvironments(params: {
  org: string
  repo?: string
  view?: "full" | "dag"
}): Promise<DetailResponse<EnvironmentGroup[]>> {
  const searchParams = new URLSearchParams()
  searchParams.set("org", params.org)
  if (params.repo) searchParams.set("repo", params.repo)
  if (params.view) searchParams.set("view", params.view)

  return fetchJson(`/environments?${searchParams}`)
}

export async function getPreviewOverview(params: {
  org: string
  repo?: string
  status?: string
  prNumber?: number
  limit?: number
  cursor?: string
}): Promise<PreviewOverviewResponse> {
  const searchParams = new URLSearchParams()
  searchParams.set("org", params.org)
  if (params.repo) searchParams.set("repo", params.repo)
  if (params.status) searchParams.set("status", params.status)
  if (params.prNumber) searchParams.set("pr_number", String(params.prNumber))
  if (params.limit) searchParams.set("limit", String(params.limit))
  if (params.cursor) searchParams.set("cursor", params.cursor)

  return fetchJson(`/previews/overview?${searchParams}`)
}

export async function listOrgs(): Promise<DetailResponse<OrgInfo[]>> {
  return fetchJson("/orgs")
}

export async function createOrg(params: { name: string; slug?: string }): Promise<DetailResponse<{ id: string; slug: string; name: string }>> {
  return postJson("/orgs", params)
}

// =============================================================================
// GitHub Integrations
// =============================================================================

export interface GithubInstallation {
  installationId: number
  githubOrgId: number
  githubOrgLogin: string
  accountType: string
  avatarUrl: string
}

export interface GithubRepo {
  githubId: number
  name: string
  fullName: string
  defaultBranch: string
  isPrivate: boolean
}

export interface RepoMapping {
  id: string
  orgId: string
  installationId: number
  githubRepoId: number
  repoFullName: string | null
  githubOrgLogin: string | null
  createdByName: string | null
  createdAt: string
}

export async function listGithubInstallations(): Promise<DetailResponse<GithubInstallation[]>> {
  return fetchJson("/integrations/github/installations")
}

export async function listInstallationRepos(installationId: number): Promise<DetailResponse<GithubRepo[]>> {
  return fetchJson(`/integrations/github/installations/${installationId}/repositories`)
}

export async function listRepoMappings(org: string): Promise<DetailResponse<RepoMapping[]>> {
  return fetchJson(`/orgs/${org}/repo-mappings`)
}

export async function createRepoMapping(
  org: string,
  params: { installationId: number; githubRepoId: number },
): Promise<DetailResponse<RepoMapping>> {
  return postJson(`/orgs/${org}/repo-mappings`, params)
}

export async function deleteRepoMapping(
  org: string,
  installationId: number,
  repoId: number,
): Promise<DetailResponse<{ removed: boolean }>> {
  return deleteJson(`/orgs/${org}/repo-mappings/${installationId}/${repoId}`)
}

// =============================================================================
// Billing
// =============================================================================

export async function createCheckoutSession(
  org: string,
  params: { priceId: string },
): Promise<DetailResponse<{ url: string }>> {
  return postJson(`/orgs/${org}/billing/checkout`, params)
}

export async function createPortalSession(
  org: string,
): Promise<DetailResponse<{ url: string }>> {
  return postJson(`/orgs/${org}/billing/portal`)
}

// =============================================================================
// Connections
// =============================================================================

export async function listOrgConnections(org: string): Promise<DetailResponse<OrgConnection[]>> {
  return fetchJson(`/orgs/${org}/connections`)
}

export async function getOrgConnection(org: string, connectionId: string): Promise<DetailResponse<OrgConnectionDetail>> {
  return fetchJson(`/orgs/${org}/connections/${connectionId}`)
}

export interface CurrentUser {
  userId: string
  name: string
  email: string
  /** GitHub user ID (numeric) - used for matching PR authors */
  githubId: number | null
}

/**
 * Get the current authenticated user's info, including their GitHub ID.
 */
export async function getMe(): Promise<DetailResponse<CurrentUser>> {
  return fetchJson("/users/me")
}

export async function getPreview(id: string): Promise<DetailResponse<Preview>> {
  return fetchJson(`/previews/${id}`)
}

export async function getPreviewRuns(id: string): Promise<{ data: Run[] }> {
  return fetchJson(`/previews/${id}/runs`)
}

export async function getPreviewOutputs(id: string): Promise<DetailResponse<unknown>> {
  return fetchJson(`/previews/${id}/outputs`)
}

export async function getRun(id: string): Promise<DetailResponse<Run>> {
  return fetchJson(`/runs/${id}`)
}

export async function getRunPlan(id: string): Promise<DetailResponse<unknown>> {
  return fetchJson(`/runs/${id}/plan`)
}

export async function getRunOutput(id: string): Promise<string> {
  const res = await fetch(`${API_BASE}/runs/${id}/output`, {
    credentials: "include",
  })
  if (!res.ok) {
    throw new Error(`API error: ${res.status}`)
  }
  return res.text()
}

export async function approvePreview(
  id: string,
  approverLogin?: string,
  githubUserId?: number,
): Promise<void> {
  await postJson(`/previews/${id}/approve`, { approverLogin, githubUserId })
}

/**
 * Cancel a running terraform operation.
 */
export async function cancelRun(runId: string): Promise<{ cancelled: boolean }> {
  const res = await postJson<{ data: { cancelled: boolean } }>(`/runs/${runId}/cancel`)
  return res.data
}

/**
 * Manually re-run a preview (plan + apply).
 */
export async function rerunPreview(previewId: string): Promise<{ rerunStarted: boolean; runGroupId: string }> {
  const res = await postJson<{ data: { rerunStarted: boolean; runGroupId: string } }>(`/previews/${previewId}/rerun`)
  return res.data
}

/**
 * Trigger apply for a preview that has a successful plan.
 * Used for manual approval after pause or for requireApproval workspaces.
 */
export async function triggerApply(previewId: string): Promise<{ applyStarted: boolean; runId: string }> {
  const res = await postJson<{ data: { applyStarted: boolean; runId: string } }>(`/previews/${previewId}/apply`)
  return res.data
}

/**
 * Pause auto-apply for a deployment.
 * Transitions from awaiting_apply to awaiting_approval.
 * After pausing, the deployment requires explicit approval to apply.
 */
export async function pauseApply(previewId: string): Promise<{ paused: boolean; status: string; message?: string }> {
  const res = await postJson<{ data: { paused: boolean; status: string; message?: string } }>(`/previews/${previewId}/pause`)
  return res.data
}

/**
 * Get all previews (workspaces) for a PR.
 */
export async function getPreviewsByPr(
  org: string,
  repo: string,
  prNumber: number,
): Promise<DetailResponse<PrPreviewGroup>> {
  return fetchJson(`/orgs/${encodeURIComponent(org)}/repos/${encodeURIComponent(repo)}/pr/${prNumber}`)
}

/**
 * Get all previews (workspaces) for a long-lived environment.
 * @deprecated Use getEnvironment instead
 */
export async function getPreviewsByEnv(
  org: string,
  repo: string,
  branch: string,
): Promise<DetailResponse<EnvPreviewGroup>> {
  return fetchJson(`/orgs/${encodeURIComponent(org)}/repos/${encodeURIComponent(repo)}/env/${encodeURIComponent(branch)}`)
}

/**
 * Get all deployments for an environment (unified endpoint).
 * Works for both PR environments (e.g., "pr-123") and named environments (e.g., "main").
 */
/**
 * Get resource spans for a run (for timeline/Gantt chart).
 */
export async function getRunSpans(runId: string): Promise<DetailResponse<ResourceSpan[]>> {
  return fetchJson(`/runs/${runId}/spans`)
}

export async function getEnvironment(
  org: string,
  repo: string,
  environmentName: string,
  opts?: {
    view?: "full" | "dag"
  },
): Promise<DetailResponse<EnvironmentPreviewGroup>> {
  const searchParams = new URLSearchParams()
  if (opts?.view) {
    searchParams.set("view", opts.view)
  }

  const query = searchParams.size > 0 ? `?${searchParams}` : ""
  return fetchJson(`/orgs/${encodeURIComponent(org)}/repos/${encodeURIComponent(repo)}/environment/${encodeURIComponent(environmentName)}${query}`)
}
