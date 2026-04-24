import { buildScanner } from "../../scripts/build-scanner"
import { deployScanner } from "../../scripts/deploy-scanner"
import { defineDeployable } from "../../scripts/ci/deployables/types"
import { CORE_DEPLOYABLE_TRIGGER_PATHS } from "../../scripts/ci/deployables/shared"

export default defineDeployable({
  name: "scanner",
  root: "apps/runner",
  supports: {
    environmentKinds: ["named", "transient"],
  },
  workspaces: ["apps/runner/infra"],
  watchedPaths: ["apps/runner/", "packages/shared/", ...CORE_DEPLOYABLE_TRIGGER_PATHS],
  build: async () => {
    await buildScanner()
  },
  deploy: async () => {
    await deployScanner()
  },
})
