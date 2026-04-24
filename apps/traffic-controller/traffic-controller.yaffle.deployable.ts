import { buildTrafficController } from "../../scripts/build-tc"
import { deployTrafficController } from "../../scripts/deploy-tc"
import { defineDeployable } from "../../scripts/ci/deployables/types"
import { CORE_DEPLOYABLE_TRIGGER_PATHS } from "../../scripts/ci/deployables/shared"

export default defineDeployable({
  name: "traffic-controller",
  root: "apps/traffic-controller",
  supports: {
    environmentKinds: ["named"],
  },
  workspaces: ["apps/traffic-controller/infra"],
  watchedPaths: ["apps/traffic-controller/", ...CORE_DEPLOYABLE_TRIGGER_PATHS],
  build: async () => {
    await buildTrafficController()
  },
  deploy: async ({ target }) => {
    await deployTrafficController({
      environment: target.environment.name,
      skipBuild: true,
      apiOnly: false,
      reconcileOnly: false,
    })
  },
})
