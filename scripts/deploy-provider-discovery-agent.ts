import {
  deployProviderDiscoveryAgent,
  parseProviderDiscoveryDeployArgs,
} from "./lib/provider-discovery-agent"

async function main(): Promise<void> {
  const args = await parseProviderDiscoveryDeployArgs("deploy-provider-discovery-agent.ts")
  await deployProviderDiscoveryAgent(args)
}

main().catch((error) => {
  console.error("Deploy failed:", error instanceof Error ? error.message : String(error))
  process.exit(1)
})
