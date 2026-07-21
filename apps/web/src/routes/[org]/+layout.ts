import { error } from "@sveltejs/kit"

import type { LayoutLoad } from "./$types"

type OrgListResponse = {
  data?: Array<{ slug: string }>
}

export const load: LayoutLoad = async ({ fetch, params }) => {
  const res = await fetch("/api/orgs")

  if (!res.ok) {
    throw error(503, "Failed to validate organization access")
  }

  const body = (await res.json()) as OrgListResponse
  const hasOrg = body.data?.some((org) => org.slug === params.org) ?? false

  if (!hasOrg) {
    throw error(404, `Organization ${params.org} not found`)
  }

  return {}
}
