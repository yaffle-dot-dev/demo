import { buildWeb } from "../../scripts/build-web"
import { verifyUrl } from "../../scripts/ci/deployables/http"
import { deployWeb } from "../../scripts/deploy-web"
import { defineDeployable } from "../../scripts/ci/deployables/types"
import { CORE_DEPLOYABLE_TRIGGER_PATHS } from "../../scripts/ci/deployables/shared"
import { fetchOutputs } from "../../scripts/lib/outputs"

export default defineDeployable({
  name: "web",
  root: "apps/web",
  supports: {
    environmentKinds: ["named", "transient"],
  },
  workspaces: ["apps/control-plane/infra", "apps/web/infra"],
  artifact: {
    type: "container-image",
    imageName: "web",
    containerName: "web",
    currentSource: "ecs-service",
  },
  watchedPaths: [
    "apps/web/",
    "packages/shared/",
    "packages/yaffle-client/",
    ...CORE_DEPLOYABLE_TRIGGER_PATHS,
  ],
  build: async ({ artifact }) => {
    await buildWeb(artifact)
  },
  deploy: async ({ artifact }) => {
    await deployWeb(artifact)
  },
  verify: async ({ target, dryRun }) => {
    if (dryRun) {
      console.log(`[dry-run] Would verify web for ${target.environment.name}`)
      return
    }

    const outputs = await fetchOutputs({
      workspace: "apps/infra",
      environment: target.environment.name,
    })
    const siteUrl = typeof outputs.site_url === "string" ? outputs.site_url.trim() : ""

    if (!siteUrl) {
      throw new Error("apps/infra must export site_url for web verification")
    }

    await verifyUrl({
      label: "web",
      url: `${siteUrl}/app/_/health`,
    })
  },
})
