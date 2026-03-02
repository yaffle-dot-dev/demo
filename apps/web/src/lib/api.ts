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

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`)
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
  const res = await fetch(`${API_BASE}/runs/${id}/output`)
  if (!res.ok) {
    throw new Error(`API error: ${res.status}`)
  }
  return res.text()
}
