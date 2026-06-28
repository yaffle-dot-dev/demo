import {
  buildProviderDiscoveryAgentBundle,
  deployProviderDiscoveryAgent,
} from "../../scripts/lib/provider-discovery-agent"
import { verifyUrl } from "../../scripts/ci/deployables/http"
import { defineDeployable } from "../../scripts/ci/deployables/types"
import { toLegacyDeployTarget } from "../../scripts/ci/deployables/legacy-target"
import { CORE_DEPLOYABLE_TRIGGER_PATHS } from "../../scripts/ci/deployables/shared"
import { fetchOutputs } from "../../scripts/lib/outputs"

export default defineDeployable({
  name: "provider-discovery-agent",
  root: "apps/provider-discovery-agent",
  supports: {
    environmentKinds: ["named", "transient"],
  },
  workspaces: ["apps/provider-discovery-agent/infra"],
  watchedPaths: ["apps/provider-discovery-agent/", ...CORE_DEPLOYABLE_TRIGGER_PATHS],
  secrets: [
    {
      name: "cloudflare-account-id",
      phase: "deploy",
      access: "value",
      source: {
        type: "workspace-output",
        workspace: "apps/provider-discovery-agent/infra",
        output: "cloudflare_account_id_secret_id",
        outputType: "aws-secret-id",
      },
      delivery: {
        type: "env",
        name: "CLOUDFLARE_ACCOUNT_ID",
      },
      fallbacks: [
        {
          type: "env",
          name: "CLOUDFLARE_ACCOUNT_ID",
        },
      ],
    },
    {
      name: "cloudflare-api-token",
      phase: "deploy",
      access: "value",
      source: {
        type: "workspace-output",
        workspace: "apps/provider-discovery-agent/infra",
        output: "cloudflare_api_token_secret_id",
        outputType: "aws-secret-id",
      },
      delivery: {
        type: "env",
        name: "CLOUDFLARE_API_TOKEN",
      },
      fallbacks: [
        {
          type: "env",
          name: "CLOUDFLARE_API_TOKEN",
        },
      ],
    },
    {
      name: "provider-discovery-agent-token",
      phase: "deploy",
      access: "value",
      source: {
        type: "workspace-output",
        workspace: "apps/provider-discovery-agent/infra",
        output: "agent_token_secret_id",
        outputType: "aws-secret-id",
      },
      delivery: {
        type: "env",
        name: "YAFFLE_PROVIDER_DISCOVERY_AGENT_TOKEN",
      },
      fallbacks: [
        {
          type: "env",
          name: "YAFFLE_PROVIDER_DISCOVERY_AGENT_TOKEN",
        },
      ],
      ensure: {
        strategy: "generate-random",
        bytes: 32,
      },
    },
    {
      name: "provider-discovery-callback-secret",
      phase: "deploy",
      access: "value",
      source: {
        type: "workspace-output",
        workspace: "apps/provider-discovery-agent/infra",
        output: "callback_secret_secret_id",
        outputType: "aws-secret-id",
      },
      delivery: {
        type: "env",
        name: "YAFFLE_PROVIDER_DISCOVERY_CALLBACK_SECRET",
      },
      fallbacks: [
        {
          type: "env",
          name: "YAFFLE_PROVIDER_DISCOVERY_CALLBACK_SECRET",
        },
      ],
      ensure: {
        strategy: "generate-random",
        bytes: 32,
      },
    },
    {
      name: "provider-discovery-github-token",
      phase: "deploy",
      access: "value",
      source: {
        type: "workspace-output",
        workspace: "apps/provider-discovery-agent/infra",
        output: "github_token_secret_id",
        outputType: "aws-secret-id",
      },
      delivery: {
        type: "env",
        name: "GITHUB_RESEARCH_TOKEN",
      },
      optional: true,
      fallbacks: [
        {
          type: "env",
          name: "GITHUB_RESEARCH_TOKEN",
        },
        {
          type: "env",
          name: "GITHUB_TOKEN",
        },
      ],
    },
  ],
  build: async () => {
    await buildProviderDiscoveryAgentBundle()
  },
  deploy: async ({ target, dryRun }) => {
    await deployProviderDiscoveryAgent({
      target: toLegacyDeployTarget(target),
      wait: false,
      skipBuild: true,
      dryRun,
    })
  },
  verify: async ({ target, dryRun }) => {
    if (dryRun) {
      console.log(`[dry-run] Would verify provider-discovery-agent for ${target.environment.name}`)
      return
    }

    const outputs = await fetchOutputs({
      workspace: "apps/provider-discovery-agent/infra",
      environment: target.environment.name,
    })
    const workerUrl = typeof outputs.worker_url === "string" ? outputs.worker_url.trim() : ""

    if (!workerUrl) {
      throw new Error(
        "apps/provider-discovery-agent/infra must export worker_url for provider-discovery-agent verification",
      )
    }

    await verifyUrl({
      label: "provider-discovery-agent",
      url: `${workerUrl}/health`,
    })
  },
})
