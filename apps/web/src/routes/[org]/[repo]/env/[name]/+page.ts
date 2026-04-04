import { browser } from "$app/environment"
import type { PageLoad } from "./$types"

import type { EnvironmentPreviewGroup } from "$lib/api"

type EnvironmentResponse = {
  data?: EnvironmentPreviewGroup
}

export const load: PageLoad = async ({ fetch, params }) => {
  if (browser) {
    return {
      initialEnvironment: null,
    }
  }

  const response = await fetch(
    `/api/orgs/${encodeURIComponent(params.org)}/repos/${encodeURIComponent(params.repo)}/environment/${encodeURIComponent(params.name)}?view=dag`,
  )

  if (!response.ok) {
    return {
      initialEnvironment: null,
    }
  }

  const body = await response.json() as EnvironmentResponse

  return {
    initialEnvironment: body.data ?? null,
  }
}
