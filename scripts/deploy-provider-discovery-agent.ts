import {
  deployProviderDiscoveryAgent,
  parseProviderDiscoveryDeployArgs,
} from "./lib/provider-discovery-agent"
import { isMain } from "./lib/module"

async function main(): Promise<void> {
  const args = await parseProviderDiscoveryDeployArgs("deploy-provider-discovery-agent.ts")
  await deployProviderDiscoveryAgent(args)
}

if (isMain(import.meta)) {
  main().catch((error) => {
    console.error("Deploy failed:", error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
