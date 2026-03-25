import type { PageServerLoad } from "./$types"

export const load: PageServerLoad = async ({ params }) => {
  return {
    org: params.org,
    connections: [],
    missingRequirements: [],
    loadError: null,
    yafflePrincipalArn: null,
  }
}
