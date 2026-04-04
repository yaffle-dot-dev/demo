import type { PageLoad } from "./$types"

import type { DependencyGraph, EnvironmentGroup, Preview } from "$lib/api"

type EnvironmentsResponse = {
  data?: EnvironmentGroup[]
}

type PreviewOverviewResponse = {
  data?: Preview[]
  dependencyGraphs?: Record<string, DependencyGraph>
  nextCursor?: string | null
}

export const load: PageLoad = async ({ fetch, params }) => {
  const org = encodeURIComponent(params.org)

  const [environmentsResponse, previewsResponse] = await Promise.all([
    fetch(`/api/environments?org=${org}&view=dag`),
    fetch(`/api/previews/overview?org=${org}`),
  ])

  const environmentsBody = environmentsResponse.ok
    ? await environmentsResponse.json() as EnvironmentsResponse
    : null
  const previewsBody = previewsResponse.ok
    ? await previewsResponse.json() as PreviewOverviewResponse
    : null

  return {
    initialEnvironments: environmentsBody?.data ?? [],
    initialPreviews: previewsBody?.data ?? [],
    initialDependencyGraphs: previewsBody?.dependencyGraphs ?? {},
  }
}
