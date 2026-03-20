import { DeleteParameterCommand, GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm"

const region = process.env.AWS_REGION ?? "us-east-1"
const testSecretStore = new Map<string, string>()

function isTestEnv(): boolean {
  return process.env.NODE_ENV === "test"
}

export interface AwsSessionCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
}

function createSsmClient(credentials?: AwsSessionCredentials): SSMClient {
  return new SSMClient({
    region,
    credentials,
  })
}

export interface StoredConnectionSecret {
  store: "ssm"
  path: string
  arn: string
}

export async function storeConnectionSecret(
  orgSlug: string,
  connectionId: string,
  kmsKeyArn: string,
  value: unknown,
  opts?: {
    credentials?: AwsSessionCredentials
  },
): Promise<StoredConnectionSecret> {
  const path = `/yaffle/org/${orgSlug}/connections/${connectionId}/secret`

  if (isTestEnv()) {
    testSecretStore.set(path, JSON.stringify(value))
    return {
      store: "ssm",
      path,
      arn: `arn:aws:ssm:${region}:000000000000:parameter${path}`,
    }
  }

  const ssm = createSsmClient(opts?.credentials)

  await ssm.send(new PutParameterCommand({
    Name: path,
    Type: "SecureString",
    Value: JSON.stringify(value),
    KeyId: kmsKeyArn,
    Overwrite: true,
  }))

  const result = await ssm.send(new GetParameterCommand({ Name: path, WithDecryption: false }))
  const arn = result.Parameter?.ARN

  if (!arn) {
    throw new Error(`Failed to resolve SSM ARN for ${path}`)
  }

  return { store: "ssm", path, arn }
}

export async function getConnectionSecret(
  path: string,
  opts?: {
    credentials?: AwsSessionCredentials
  },
): Promise<unknown> {
  if (isTestEnv()) {
    const value = testSecretStore.get(path)
    if (!value) {
      throw new Error(`No secret value found at ${path}`)
    }
    return JSON.parse(value)
  }

  const ssm = createSsmClient(opts?.credentials)

  const result = await ssm.send(new GetParameterCommand({
    Name: path,
    WithDecryption: true,
  }))

  const value = result.Parameter?.Value
  if (!value) {
    throw new Error(`No secret value found at ${path}`)
  }

  return JSON.parse(value)
}

export async function deleteConnectionSecret(
  path: string,
  opts?: {
    credentials?: AwsSessionCredentials
  },
): Promise<void> {
  if (isTestEnv()) {
    testSecretStore.delete(path)
    return
  }

  const ssm = createSsmClient(opts?.credentials)
  await ssm.send(new DeleteParameterCommand({ Name: path }))
}
