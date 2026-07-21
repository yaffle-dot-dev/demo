import { buildMarketingSite, deployMarketingSite } from "../../scripts/deploy-marketing"
import { verifyUrl } from "../../scripts/ci/deployables/http"
import { defineDeployable } from "../../scripts/ci/deployables/types"
import { toLegacyDeployTarget } from "../../scripts/ci/deployables/legacy-target"
import { CORE_DEPLOYABLE_TRIGGER_PATHS } from "../../scripts/ci/deployables/shared"
import { fetchOutputs } from "../../scripts/lib/outputs"

export default defineDeployable({
  name: "marketing",
  root: "apps/marketing",
  supports: {
    environmentKinds: ["named", "transient"],
  },
  workspaces: ["apps/marketing/infra", "apps/infra"],
  watchedPaths: ["apps/marketing/", ...CORE_DEPLOYABLE_TRIGGER_PATHS],
  build: async ({ target, dryRun }) => {
    await buildMarketingSite(toLegacyDeployTarget(target), false, dryRun)
  },
  deploy: async ({ target, dryRun }) => {
    await deployMarketingSite({
      target: toLegacyDeployTarget(target),
      wait: false,
      skipBuild: true,
      dryRun,
    })
  },
  verify: async ({ target, dryRun }) => {
    if (dryRun) {
      console.log(`[dry-run] Would verify marketing for ${target.environment.name}`)
      return
    }

    const outputs = await fetchOutputs({
      workspace: "apps/infra",
      environment: target.environment.name,
    })
    const marketingUrl =
      typeof outputs.marketing_url === "string" ? outputs.marketing_url.trim() : ""

    if (!marketingUrl) {
      throw new Error("apps/infra must export marketing_url for marketing verification")
    }

    await verifyUrl({
      label: "marketing",
      url: marketingUrl,
    })
  },
})
