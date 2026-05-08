import { buildRunner } from "../../scripts/build-runner"
import { deployRunner } from "../../scripts/deploy-runner"
import { defineDeployable } from "../../scripts/ci/deployables/types"
import { CORE_DEPLOYABLE_TRIGGER_PATHS } from "../../scripts/ci/deployables/shared"

export default defineDeployable({
  name: "runner",
  root: "apps/runner",
  supports: {
    environmentKinds: ["named", "transient"],
  },
  workspaces: ["apps/runner/infra"],
  artifact: {
    type: "container-image",
    imageName: "runner",
    containerName: "runner",
    currentSource: "ecs-task-definition",
  },
  watchedPaths: ["apps/runner/", "packages/shared/", ...CORE_DEPLOYABLE_TRIGGER_PATHS],
  build: async ({ artifact }) => {
    await buildRunner(artifact)
  },
  deploy: async ({ artifact }) => {
    await deployRunner(artifact)
  },
})
