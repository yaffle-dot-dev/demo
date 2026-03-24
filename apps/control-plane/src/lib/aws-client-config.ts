interface ExplicitAwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export function getExplicitAwsCredentials(): ExplicitAwsCredentials | undefined {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim()

  if (!accessKeyId || !secretAccessKey) {
    return undefined
  }

  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env.AWS_SESSION_TOKEN?.trim() || undefined,
  }
}

export function getAwsClientConfig(region: string): {
  region: string
  credentials?: ExplicitAwsCredentials
} {
  const credentials = getExplicitAwsCredentials()
  return credentials
    ? { region, credentials }
    : { region }
}
