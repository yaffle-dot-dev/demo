const API_BASE = "/api"

export interface Preview {
  id: string
  repo: string
  prNumber: number
  workspacePath: string
  branch: string
  headSha: string
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
  headSha: string
  lastRunId: string | null
  lastRunType: string | null
  lastRunStatus: string | null
  lastRunCompletedAt: string | null
  planSummary: string | null
}

export interface EnvironmentGroup {
  repo: string
  branch: string
  headSha: string
  status: string
  updatedAt: string
  workspaces: EnvironmentWorkspace[]
}

export interface OrgInfo {
  id: string
  login: string
  role: string
}

// Compact preview shape for grouped views (less fields than full Preview)
export interface WorkspacePreview {
  id: string
  workspacePath: string
  status: string
  stateKey: string
  mode: string
  requireApproval: boolean
  createdAt: string
}

export interface WorkspaceWithRuns {
  preview: WorkspacePreview
  runs: Run[]
  outputs: unknown | null
}

export interface PrPreviewGroup {
  org: string
  repo: string
  prNumber: number
  branch: string
  headSha: string
  authorLogin: string | null
  workspaces: WorkspaceWithRuns[]
}

export interface EnvPreviewGroup {
  org: string
  repo: string
  branch: string
  headSha: string
  workspaces: WorkspaceWithRuns[]
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: buildAuthHeaders(),
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

function buildAuthHeaders(): HeadersInit {
  if (typeof window === "undefined") return {}

  // Use Bearer token auth (primary method)
  const accessToken = localStorage.getItem("yaffle.accessToken")
  if (accessToken) {
    return {
      Authorization: `Bearer ${accessToken}`,
    }
  }

  return {}
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
}): Promise<DetailResponse<EnvironmentGroup[]>> {
  const searchParams = new URLSearchParams()
  searchParams.set("org", params.org)
  if (params.repo) searchParams.set("repo", params.repo)

  return fetchJson(`/environments?${searchParams}`)
}

export async function listOrgs(): Promise<DetailResponse<OrgInfo[]>> {
  return fetchJson("/orgs")
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
    headers: buildAuthHeaders(),
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
  const res = await fetch(`${API_BASE}/previews/${id}/approve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...buildAuthHeaders(),
    },
    body: JSON.stringify({ approverLogin, githubUserId }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `API error: ${res.status}`)
  }
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
 */
export async function getPreviewsByEnv(
  org: string,
  repo: string,
  branch: string,
): Promise<DetailResponse<EnvPreviewGroup>> {
  return fetchJson(`/orgs/${encodeURIComponent(org)}/repos/${encodeURIComponent(repo)}/env/${encodeURIComponent(branch)}`)
}
