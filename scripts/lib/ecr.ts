/**
 * ECR authentication helpers using AWS SDK.
 */

import { ECRClient, GetAuthorizationTokenCommand } from "@aws-sdk/client-ecr"

const loginByRegistry = new Map<string, Promise<void>>()

/**
 * Login to ECR by configuring standard container registry credentials.
 * Docker-compatible clients like skopeo can reuse ~/.docker/config.json.
 */
export async function loginToEcr(registry: string, region: string): Promise<void> {
  const cacheKey = `${region}:${registry}`
  const existing = loginByRegistry.get(cacheKey)
  if (existing) {
    await existing
    return
  }

  const loginPromise = (async () => {
    const client = new ECRClient({ region })
    const result = await client.send(new GetAuthorizationTokenCommand({}))

    const authData = result.authorizationData?.[0]
    if (!authData?.authorizationToken) {
      throw new Error("Failed to get ECR authorization token")
    }

    const decoded = atob(authData.authorizationToken)
    const [username, password] = decoded.split(":")

    if (!username || !password) {
      throw new Error("Invalid ECR authorization token")
    }

    const dockerConfigDir = `${process.env.HOME}/.docker`
    const dockerConfigPath = `${dockerConfigDir}/config.json`

    await Bun.write(`${dockerConfigDir}/.keep`, "")
    const fs = await import("node:fs")
    fs.mkdirSync(dockerConfigDir, { recursive: true })

    let config: Record<string, any> = {}
    try {
      config = JSON.parse(await Bun.file(dockerConfigPath).text())
    } catch {
      // No existing config
    }

    config.auths = config.auths ?? {}
    config.auths[registry] = {
      auth: authData.authorizationToken,
    }

    await Bun.write(dockerConfigPath, JSON.stringify(config, null, 2))
    console.log(`Logged in to ECR: ${registry}`)
  })()

  loginByRegistry.set(cacheKey, loginPromise)

  try {
    await loginPromise
  } catch (error) {
    loginByRegistry.delete(cacheKey)
    throw error
  }
}
