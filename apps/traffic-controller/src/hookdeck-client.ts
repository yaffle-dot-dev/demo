import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager"
import { HookdeckClient, type Hookdeck } from "@hookdeck/sdk"

let cachedHookdeckApiKeyPromise: Promise<string> | undefined

export interface HookdeckRoutingConfig {
  apiKey: string
  githubSourceId: string
  githubSourceName: string
  productionDestinationId: string
  productionDestinationName: string
  productionConnectionName: string
}

export interface HookdeckRoutingClient {
  upsertDestination(request: Hookdeck.DestinationUpsertRequest): Promise<Hookdeck.Destination>
  upsertConnection(request: Hookdeck.ConnectionUpsertRequest): Promise<Hookdeck.Connection>
  deleteConnection(id: string): Promise<void>
}

async function getHookdeckApiKey(): Promise<string> {
  if (process.env.HOOKDECK_API_KEY?.trim()) {
    return process.env.HOOKDECK_API_KEY.trim()
  }

  const secretId = process.env.HOOKDECK_API_KEY_SECRET_ARN?.trim()
  if (!secretId) {
    throw new Error("HOOKDECK_API_KEY or HOOKDECK_API_KEY_SECRET_ARN must be configured")
  }

  cachedHookdeckApiKeyPromise ??= (async () => {
    const client = new SecretsManagerClient({})
    const secret = await client.send(new GetSecretValueCommand({ SecretId: secretId }))
    if (!secret.SecretString?.trim()) {
      throw new Error(`Secrets Manager secret '${secretId}' did not contain SecretString`)
    }

    return secret.SecretString.trim()
  })()

  return cachedHookdeckApiKeyPromise
}

export async function getHookdeckRoutingConfig(): Promise<HookdeckRoutingConfig> {
  const githubSourceId = process.env.HOOKDECK_GITHUB_SOURCE_ID?.trim() ?? ""
  const githubSourceName = process.env.HOOKDECK_GITHUB_SOURCE_NAME?.trim() ?? ""
  const productionDestinationId = process.env.HOOKDECK_PRODUCTION_DESTINATION_ID?.trim() ?? ""
  const productionDestinationName = process.env.HOOKDECK_PRODUCTION_DESTINATION_NAME?.trim() ?? ""
  const productionConnectionName = process.env.HOOKDECK_PRODUCTION_CONNECTION_NAME?.trim() ?? ""

  if (!githubSourceId || !productionDestinationId || !productionConnectionName) {
    throw new Error("Hookdeck routing environment is incomplete")
  }

  return {
    apiKey: await getHookdeckApiKey(),
    githubSourceId,
    githubSourceName,
    productionDestinationId,
    productionDestinationName,
    productionConnectionName,
  }
}

class SdkHookdeckRoutingClient implements HookdeckRoutingClient {
  constructor(private readonly client: HookdeckClient) {}

  async upsertDestination(request: Hookdeck.DestinationUpsertRequest): Promise<Hookdeck.Destination> {
    return this.client.destination.upsert(request)
  }

  async upsertConnection(request: Hookdeck.ConnectionUpsertRequest): Promise<Hookdeck.Connection> {
    return this.client.connection.upsert(request)
  }

  async deleteConnection(id: string): Promise<void> {
    await this.client.connection.delete(id)
  }
}

export async function createHookdeckRoutingClient(): Promise<HookdeckRoutingClient> {
  const config = await getHookdeckRoutingConfig()
  return new SdkHookdeckRoutingClient(new HookdeckClient({ token: config.apiKey }))
}
