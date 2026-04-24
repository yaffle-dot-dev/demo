import { buildDocsSite, deployDocsSite } from "../../scripts/deploy-docs"
import { verifyUrl } from "../../scripts/ci/deployables/http"
import { defineDeployable } from "../../scripts/ci/deployables/types"
import { toLegacyDeployTarget } from "../../scripts/ci/deployables/legacy-target"
import { CORE_DEPLOYABLE_TRIGGER_PATHS } from "../../scripts/ci/deployables/shared"
import { fetchOutputs } from "../../scripts/lib/outputs"

export default defineDeployable({
  name: "docs",
  root: "apps/docs",
  supports: {
    environmentKinds: ["named", "transient"],
  },
  workspaces: ["apps/docs/infra", "apps/infra"],
  watchedPaths: ["apps/docs/", ...CORE_DEPLOYABLE_TRIGGER_PATHS],
  build: async ({ dryRun }) => {
    await buildDocsSite(dryRun)
  },
  deploy: async ({ target, dryRun }) => {
    await deployDocsSite({
      target: toLegacyDeployTarget(target),
      wait: false,
      skipBuild: true,
      dryRun,
    })
  },
  verify: async ({ target, dryRun }) => {
    if (dryRun) {
      console.log(`[dry-run] Would verify docs for ${target.environment.name}`)
      return
    }

    const outputs = await fetchOutputs({
      workspace: "apps/infra",
      environment: target.environment.name,
      wait: false,
    })
    const docsUrl = typeof outputs.docs_url === "string" ? outputs.docs_url.trim() : ""

    if (!docsUrl) {
      throw new Error("apps/infra must export docs_url for docs verification")
    }

    await verifyUrl({
      label: "docs",
      url: docsUrl,
    })
  },
})
