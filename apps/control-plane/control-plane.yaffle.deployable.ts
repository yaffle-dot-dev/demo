import { buildCp } from "../../scripts/build-cp"
import { dbMigrate } from "../../scripts/db-migrate"
import { deployCp } from "../../scripts/deploy-cp"
import { verifyUrl } from "../../scripts/ci/deployables/http"
import { defineDeployable } from "../../scripts/ci/deployables/types"
import { CORE_DEPLOYABLE_TRIGGER_PATHS } from "../../scripts/ci/deployables/shared"
import { fetchOutputs } from "../../scripts/lib/outputs"

export default defineDeployable({
  name: "control-plane",
  root: "apps/control-plane",
  supports: {
    environmentKinds: ["named", "transient"],
  },
  workspaces: ["apps/control-plane/infra"],
  artifact: {
    type: "container-image",
    imageName: "control-plane",
    containerName: "control-plane",
    currentSource: "ecs-service",
  },
  watchedPaths: ["apps/control-plane/", "packages/shared/", ...CORE_DEPLOYABLE_TRIGGER_PATHS],
  secrets: [
    {
      name: "database-url",
      phase: "prepare",
      access: "value",
      source: {
        type: "workspace-output",
        workspace: "apps/control-plane/infra",
        output: "database_migration_url_secret_arn",
        outputType: "aws-secret-arn",
      },
      delivery: {
        type: "env",
        name: "YAFFLE_MIGRATION_DATABASE_URL",
      },
      fallbacks: [
        {
          type: "env",
          name: "YAFFLE_MIGRATION_DATABASE_URL",
        },
        {
          type: "aws-secretsmanager",
          secretId: "yaffle/ci/${environment}/database-migration-url",
        },
        {
          type: "env",
          name: "ROOT_DATABASE_URL",
        },
      ],
    },
    {
      name: "provider-discovery-agent-token-runtime",
      phase: "deploy",
      access: "value",
      source: {
        type: "workspace-output",
        workspace: "apps/control-plane/infra",
        output: "provider_discovery_agent_token_secret_arn",
        outputType: "aws-secret-arn",
      },
      delivery: {
        type: "none",
      },
      fallbacks: [
        {
          type: "aws-secretsmanager",
          secretId: "yaffle/${environment}/provider-discovery-agent/agent-token",
        },
        {
          type: "env",
          name: "YAFFLE_PROVIDER_DISCOVERY_AGENT_TOKEN",
        },
      ],
    },
    {
      name: "provider-discovery-callback-secret-runtime",
      phase: "deploy",
      access: "value",
      source: {
        type: "workspace-output",
        workspace: "apps/control-plane/infra",
        output: "provider_discovery_callback_secret_arn",
        outputType: "aws-secret-arn",
      },
      delivery: {
        type: "none",
      },
      fallbacks: [
        {
          type: "aws-secretsmanager",
          secretId: "yaffle/${environment}/provider-discovery-agent/callback-secret",
        },
        {
          type: "env",
          name: "YAFFLE_PROVIDER_DISCOVERY_CALLBACK_SECRET",
        },
      ],
    },
  ],
  prepare: async ({ target, dryRun }) => {
    if (dryRun) {
      console.log(`[dry-run] Would run control-plane migrations for ${target.environment.name}`)
      return
    }

    await dbMigrate()
  },
  build: async ({ artifact }) => {
    await buildCp(artifact)
  },
  deploy: async ({ artifact }) => {
    await deployCp(artifact)
  },
  verify: async ({ target, dryRun }) => {
    if (dryRun) {
      console.log(`[dry-run] Would verify control-plane for ${target.environment.name}`)
      return
    }

    const outputs = await fetchOutputs({
      workspace: "apps/control-plane/infra",
      environment: target.environment.name,
      wait: false,
    })
    const apiUrl = typeof outputs.api_url === "string" ? outputs.api_url.trim() : ""

    if (!apiUrl) {
      throw new Error("apps/control-plane/infra must export api_url for control-plane verification")
    }

    await verifyUrl({
      label: "control-plane",
      url: `${apiUrl}/api/health`,
    })
  },
})
