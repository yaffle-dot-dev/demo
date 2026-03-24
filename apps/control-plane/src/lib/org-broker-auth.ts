import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts"

import type { AwsSessionCredentials } from "./connection-secrets.ts"
import { getAwsClientConfig } from "./aws-client-config.ts"

const sts = new STSClient(getAwsClientConfig(process.env.AWS_REGION ?? "us-east-1"))

export async function assumeOrgBrokerRole(
  orgId: string,
  orgBrokerRoleArn: string,
): Promise<AwsSessionCredentials> {
  if (process.env.NODE_ENV === "test") {
    return {
      accessKeyId: "test-access-key-id",
      secretAccessKey: "test-secret-access-key",
      sessionToken: "test-session-token",
    }
  }

  const assumed = await sts.send(new AssumeRoleCommand({
    RoleArn: orgBrokerRoleArn,
    RoleSessionName: `yaffle-org-${orgId.slice(0, 8)}`,
    DurationSeconds: 3600,
  }))

  if (!assumed.Credentials?.AccessKeyId || !assumed.Credentials.SecretAccessKey || !assumed.Credentials.SessionToken) {
    throw new Error(`Failed to assume organization broker role for ${orgId}`)
  }

  return {
    accessKeyId: assumed.Credentials.AccessKeyId,
    secretAccessKey: assumed.Credentials.SecretAccessKey,
    sessionToken: assumed.Credentials.SessionToken,
  }
}
