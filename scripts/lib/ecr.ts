/**
 * ECR authentication helpers using AWS SDK.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"

import {
  DescribeImagesCommand,
  ECRClient,
  GetAuthorizationTokenCommand,
  ImageNotFoundException,
  RepositoryNotFoundException,
} from "@aws-sdk/client-ecr"

const loginByRegistry = new Map<string, Promise<void>>()

function parseRepositoryFromImageUri(imageUri: string): { registry: string; repository: string; tag: string | null } {
  const [registryAndRepo, tagPart] = imageUri.split(":", 2)
  const slashIndex = registryAndRepo.indexOf("/")
  if (slashIndex === -1) {
    throw new Error(`Invalid ECR image URI: ${imageUri}`)
  }

  return {
    registry: registryAndRepo.slice(0, slashIndex),
    repository: registryAndRepo.slice(slashIndex + 1),
    tag: tagPart ?? null,
  }
}

export async function imageTagExists(imageUri: string, region: string): Promise<boolean> {
  const { repository, tag } = parseRepositoryFromImageUri(imageUri)
  if (!tag) {
    throw new Error(`Image URI must include a tag: ${imageUri}`)
  }

  const client = new ECRClient({ region })

  try {
    const response = await client.send(new DescribeImagesCommand({
      repositoryName: repository,
      imageIds: [{ imageTag: tag }],
    }))
    return (response.imageDetails?.length ?? 0) > 0
  } catch (error) {
    if (error instanceof ImageNotFoundException || error instanceof RepositoryNotFoundException) {
      return false
    }
    throw error
  }
}

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

    const decoded = Buffer.from(authData.authorizationToken, "base64").toString("utf8")
    const [username, password] = decoded.split(":")

    if (!username || !password) {
      throw new Error("Invalid ECR authorization token")
    }

    const dockerConfigDir = `${process.env.HOME}/.docker`
    const dockerConfigPath = `${dockerConfigDir}/config.json`

    await mkdir(dockerConfigDir, { recursive: true })

    let config: Record<string, any> = {}
    try {
      config = JSON.parse(await readFile(dockerConfigPath, "utf8"))
    } catch {
      // No existing config
    }

    config.auths = config.auths ?? {}
    config.auths[registry] = {
      auth: authData.authorizationToken,
    }

    await writeFile(dockerConfigPath, JSON.stringify(config, null, 2))
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
