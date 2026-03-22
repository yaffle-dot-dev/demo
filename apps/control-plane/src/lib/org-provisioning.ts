/**
 * Organization Security Provisioning
 *
 * Creates per-org AWS resources for state isolation:
 * - KMS CMK for encrypting state files
 * - IAM role for org-scoped runner access
 *
 * Uses AWS SDK temporarily - will migrate to Terraform for dogfooding.
 */

import {
  CreateKeyCommand,
  CreateAliasCommand,
  DeleteAliasCommand,
  DescribeKeyCommand,
  ScheduleKeyDeletionCommand,
  KMSClient,
  PutKeyPolicyCommand,
  TagResourceCommand,
} from "@aws-sdk/client-kms"
import {
  CreateRoleCommand,
  DeleteRoleCommand,
  GetRoleCommand,
  UpdateAssumeRolePolicyCommand,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
  IAMClient,
  TagRoleCommand,
} from "@aws-sdk/client-iam"
import { buildOrgResourceTags, toIamTags, toKmsTags } from "./aws-tags.ts"
import { logger } from "./telemetry.ts"

// =============================================================================
// Retry Helper
// =============================================================================

interface RetryOptions {
  maxAttempts: number
  initialDelayMs: number
  maxDelayMs: number
  shouldRetry?: (err: unknown) => boolean
  onRetry?: (attempt: number, err: unknown) => void
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  let lastError: unknown
  let delayMs = options.initialDelayMs

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err

      // Check if we should retry
      if (options.shouldRetry && !options.shouldRetry(err)) {
        throw err
      }

      // Last attempt - don't retry
      if (attempt === options.maxAttempts) {
        throw err
      }

      // Notify caller
      options.onRetry?.(attempt, err)

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delayMs))

      // Exponential backoff
      delayMs = Math.min(delayMs * 2, options.maxDelayMs)
    }
  }

  throw lastError
}

// =============================================================================
// Configuration
// =============================================================================

function getConfig(): { region: string; stateBucket: string; controlPlaneRoleArn: string } {
  const region = process.env.AWS_REGION ?? "us-east-1"
  const stateBucket = process.env.YAFFLE_STATE_BUCKET
  const controlPlaneRoleArn = process.env.YAFFLE_CONTROL_PLANE_ROLE_ARN

  if (!stateBucket) {
    throw new Error("YAFFLE_STATE_BUCKET environment variable required")
  }
  if (!controlPlaneRoleArn) {
    throw new Error("YAFFLE_CONTROL_PLANE_ROLE_ARN environment variable required")
  }
  if (!/^arn:aws(-[a-z]+)?:iam::\d{12}:role\/.+$/.test(controlPlaneRoleArn)) {
    throw new Error("YAFFLE_CONTROL_PLANE_ROLE_ARN must be an IAM role ARN (not root)")
  }

  return { region, stateBucket, controlPlaneRoleArn }
}

// Cached clients
let kmsClient: KMSClient | undefined
let iamClient: IAMClient | undefined

function getKmsClient(region: string): KMSClient {
  if (!kmsClient) {
    kmsClient = new KMSClient({ region })
  }
  return kmsClient
}

function getIamClient(region: string): IAMClient {
  if (!iamClient) {
    iamClient = new IAMClient({ region })
  }
  return iamClient
}

// =============================================================================
// Provisioning Result
// =============================================================================

export interface ProvisioningResult {
  kmsKeyArn: string
  kmsKeyAlias: string
  iamRoleArn: string
}

const ORG_BROKER_POLICY_NAME = "customer-assume-access"

function orgBrokerRoleName(orgId: string): string {
  return `yaffle-org-broker-${orgId}`
}

function buildOrgBrokerPolicy(params: {
  orgSlug: string
  kmsKeyArn: string
  customerRoleArns: string[]
}): string {
  const { orgSlug, kmsKeyArn, customerRoleArns } = params
  const normalizedRoleArns = [...new Set(customerRoleArns.map((value) => value.trim()).filter(Boolean))].sort()

  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "OrgScopedConnectionSecretAccess",
        Effect: "Allow",
        Action: [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:PutParameter",
          "ssm:AddTagsToResource",
          "ssm:DeleteParameter",
        ],
        Resource: `arn:aws:ssm:${getConfig().region}:*:parameter/yaffle/org/${orgSlug}/connections/*`,
      },
      {
        Sid: "OrgKmsUsage",
        Effect: "Allow",
        Action: [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:GenerateDataKey",
        ],
        Resource: kmsKeyArn,
      },
      ...(normalizedRoleArns.length === 0
        ? [
          {
            Sid: "DenyAllAssumeRole",
            Effect: "Deny",
            Action: "sts:AssumeRole",
            Resource: "*",
          },
        ]
        : [
          {
            Sid: "AssumeCustomerRoles",
            Effect: "Allow",
            Action: "sts:AssumeRole",
            Resource: normalizedRoleArns,
          },
        ]),
    ],
  })
}

/**
 * Update the per-org broker role policy with the exact customer role allowlist.
 */
export async function syncOrgBrokerRoleAssumeTargets(
  orgId: string,
  orgSlug: string,
  orgBrokerRoleArn: string,
  kmsKeyArn: string,
  customerRoleArns: string[],
): Promise<void> {
  if (process.env.NODE_ENV === "test") {
    return
  }

  if (!/^arn:aws(-[a-z]+)?:iam::\d{12}:role\/.+$/.test(orgBrokerRoleArn)) {
    throw new Error("Organization broker role ARN is not valid")
  }

  for (const arn of customerRoleArns) {
    if (!/^arn:aws(-[a-z]+)?:iam::\d{12}:role\/.+$/.test(arn)) {
      throw new Error(`Invalid customer role ARN: ${arn}`)
    }
  }

  const config = getConfig()
  const iam = getIamClient(config.region)

  await iam.send(new PutRolePolicyCommand({
    RoleName: orgBrokerRoleName(orgId),
    PolicyName: ORG_BROKER_POLICY_NAME,
    PolicyDocument: buildOrgBrokerPolicy({
      orgSlug,
      kmsKeyArn,
      customerRoleArns,
    }),
  }))
}

// =============================================================================
// KMS Key Provisioning
// =============================================================================

interface KmsKeyResult {
  keyArn: string
  keyAlias: string
}

async function createOrgKmsKey(
  orgId: string,
  controlPlaneRoleArn: string,
  orgBrokerRoleArn: string,
): Promise<KmsKeyResult> {
  const config = getConfig()
  const kms = getKmsClient(config.region)

  const keyAlias = `alias/yaffle-org-${orgId}`
  const orgResourceTags = toKmsTags(buildOrgResourceTags(
    { orgId },
    { resourceClass: "kms-key" },
  ))

  // Check if key already exists (from a previous attempt)
  let keyArn: string | undefined
  try {
    const describeResponse = await kms.send(new DescribeKeyCommand({ KeyId: keyAlias }))
    keyArn = describeResponse.KeyMetadata?.Arn
    if (keyArn) {
      logger.info("KMS key already exists, reusing", { orgId, keyAlias, keyArn })
    }
  } catch (err) {
    // NotFoundException means key doesn't exist - that's fine, we'll create it
    const errorName = err instanceof Error ? err.name : ""
    if (errorName !== "NotFoundException") {
      throw err
    }
  }

  // Create the key if it doesn't exist
  if (!keyArn) {
    const createResponse = await kms.send(new CreateKeyCommand({
      Description: `Yaffle state encryption key for org ${orgId}`,
      Tags: orgResourceTags,
    }))

    keyArn = createResponse.KeyMetadata?.Arn
    if (!keyArn) {
      throw new Error("KMS CreateKey did not return key ARN")
    }

    // Create alias for new key
    await kms.send(new CreateAliasCommand({
      AliasName: keyAlias,
      TargetKeyId: keyArn,
    }))
  }

  await kms.send(new TagResourceCommand({
    KeyId: keyArn,
    Tags: orgResourceTags,
  }))

  // Set key policy - control plane can manage, org broker can use data key ops.
  const keyPolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "YaffleControlPlaneAdmin",
        Effect: "Allow",
        Principal: { AWS: controlPlaneRoleArn },
        Action: "kms:*",
        Resource: "*",
      },
      {
        Sid: "YaffleOrgBrokerUsage",
        Effect: "Allow",
        Principal: { AWS: orgBrokerRoleArn },
        Action: [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:GenerateDataKey",
        ],
        Resource: "*",
      },
    ],
  })

  // Retry putting key policy - IAM role may not have propagated yet
  await retryWithBackoff(
    () => kms.send(new PutKeyPolicyCommand({
      KeyId: keyArn,
      PolicyName: "default",
      Policy: keyPolicy,
    })),
    {
      maxAttempts: 10,
      initialDelayMs: 1000,
      maxDelayMs: 5000,
      shouldRetry: (err) => {
        // Retry on MalformedPolicyDocumentException with "invalid principals"
        // This happens when IAM role hasn't propagated yet
        const message = err instanceof Error ? err.message : String(err)
        return message.includes("invalid principals")
      },
      onRetry: (attempt, err) => {
        logger.info("Retrying KMS PutKeyPolicy (waiting for IAM propagation)", {
          orgId,
          attempt,
          error: err instanceof Error ? err.message : String(err),
        })
      },
    },
  )

  logger.info("Created KMS key for org", {
    orgId,
    keyArn,
    keyAlias,
  })

  return { keyArn, keyAlias }
}

export async function syncOrgKmsKeyPolicy(
  orgId: string,
  kmsKeyArn: string,
  orgBrokerRoleArn: string,
): Promise<void> {
  if (process.env.NODE_ENV === "test") {
    return
  }

  const config = getConfig()
  const kms = getKmsClient(config.region)

  const keyPolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "YaffleControlPlaneAdmin",
        Effect: "Allow",
        Principal: { AWS: config.controlPlaneRoleArn },
        Action: "kms:*",
        Resource: "*",
      },
      {
        Sid: "YaffleOrgBrokerUsage",
        Effect: "Allow",
        Principal: { AWS: orgBrokerRoleArn },
        Action: [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:GenerateDataKey",
        ],
        Resource: "*",
      },
    ],
  })

  await kms.send(new PutKeyPolicyCommand({
    KeyId: kmsKeyArn,
    PolicyName: "default",
    Policy: keyPolicy,
  }))

  logger.info("Synced org KMS key policy", {
    orgId,
    kmsKeyArn,
    orgBrokerRoleArn,
  })
}

// =============================================================================
// IAM Role Provisioning
// =============================================================================

async function createOrgIamRole(orgId: string): Promise<string> {
  const config = getConfig()
  const iam = getIamClient(config.region)

  const roleName = orgBrokerRoleName(orgId)
  const orgResourceTags = toIamTags(buildOrgResourceTags(
    { orgId },
    { resourceClass: "iam-role" },
  ))

  // Trust policy - only control-plane base role can assume org broker role
  const trustPolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: {
          AWS: config.controlPlaneRoleArn,
        },
        Action: "sts:AssumeRole",
      },
    ],
  })

  logger.info("Creating IAM role with trust policy", {
    orgId,
    roleName,
    controlPlaneRoleArn: config.controlPlaneRoleArn,
    trustPolicy,
  })

  // Create the role (or get existing if already created)
  let roleArn: string
  try {
    const createResponse = await iam.send(new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: trustPolicy,
      Description: `Yaffle org broker role for org ${orgId}`,
      Tags: orgResourceTags,
    }))
    roleArn = createResponse.Role?.Arn ?? ""
    if (!roleArn) {
      throw new Error("IAM CreateRole did not return role ARN")
    }
  } catch (err) {
    // Handle EntityAlreadyExistsException - role was created in a previous attempt
    const errorName = err instanceof Error ? err.name : ""
    if (errorName === "EntityAlreadyExistsException") {
      logger.info("IAM role already exists, fetching ARN", { orgId, roleName })
      const getResponse = await iam.send(new GetRoleCommand({ RoleName: roleName }))
      roleArn = getResponse.Role?.Arn ?? ""
      if (!roleArn) {
        throw new Error("IAM GetRole did not return role ARN")
      }
    } else {
      logger.error("IAM CreateRole failed", {
        orgId,
        roleName,
        error: err instanceof Error ? err.message : String(err),
        errorName: err instanceof Error ? err.name : "Unknown",
        errorStack: err instanceof Error ? err.stack : undefined,
        awsError: JSON.stringify(err, Object.getOwnPropertyNames(err as object)),
      })
      throw err
    }
  }

  // Reconcile trust policy even when role already existed, so drift (e.g. root principal)
  // is corrected during migration/backfill runs.
  await iam.send(new UpdateAssumeRolePolicyCommand({
    RoleName: roleName,
    PolicyDocument: trustPolicy,
  }))

  await iam.send(new TagRoleCommand({
    RoleName: roleName,
    Tags: orgResourceTags,
  }))

  logger.info("Created IAM role for org", {
    orgId,
    roleName,
    roleArn,
  })

  return roleArn
}

/**
 * Ensure the org broker role exists and return its ARN.
 */
export async function ensureOrgBrokerRole(orgId: string): Promise<string> {
  return createOrgIamRole(orgId)
}

// =============================================================================
// Main Provisioning Function
// =============================================================================

/**
 * Provision AWS resources for a new organization.
 *
 * Creates (in order):
 * 1. IAM org broker role `yaffle-org-broker-{uuid}`
 * 2. KMS key with alias `alias/yaffle-org-{uuid}`
 */
export async function provisionOrgResources(
  orgId: string,
  orgSlug: string,
): Promise<ProvisioningResult> {
  const config = getConfig()

  logger.info("Starting org provisioning", { orgId })

  // Create IAM broker role first.
  const iamRoleArn = await createOrgIamRole(orgId)

  // Create KMS key (control plane role is key admin).
  const { keyArn, keyAlias } = await createOrgKmsKey(orgId, config.controlPlaneRoleArn, iamRoleArn)

  await syncOrgBrokerRoleAssumeTargets(orgId, orgSlug, iamRoleArn, keyArn, [])

  logger.info("Org provisioning complete", {
    orgId,
    kmsKeyArn: keyArn,
    kmsKeyAlias: keyAlias,
    iamRoleArn,
  })

  return {
    kmsKeyArn: keyArn,
    kmsKeyAlias: keyAlias,
    iamRoleArn,
  }
}

// =============================================================================
// Deprovisioning Function
// =============================================================================

/**
 * Deprovision AWS resources for an organization.
 *
 * - Schedules KMS key for deletion (7 day minimum)
 * - Deletes IAM role and policies
 */
export async function deprovisionOrgResources(
  orgId: string,
  kmsKeyArn?: string,
  iamRoleArn?: string,
): Promise<void> {
  const config = getConfig()
  const kms = getKmsClient(config.region)
  const iam = getIamClient(config.region)

  logger.info("Starting org deprovisioning", { orgId, kmsKeyArn, iamRoleArn })

  // Delete KMS alias and schedule key deletion
  if (kmsKeyArn) {
    const keyAlias = `alias/yaffle-org-${orgId}`

    try {
      await kms.send(new DeleteAliasCommand({
        AliasName: keyAlias,
      }))
    } catch (err) {
      logger.warn("Failed to delete KMS alias (may not exist)", {
        orgId,
        keyAlias,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    try {
      await kms.send(new ScheduleKeyDeletionCommand({
        KeyId: kmsKeyArn,
        PendingWindowInDays: 7, // Minimum allowed
      }))
      logger.info("Scheduled KMS key deletion", { orgId, kmsKeyArn })
    } catch (err) {
      logger.warn("Failed to schedule KMS key deletion", {
        orgId,
        kmsKeyArn,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Delete IAM role
  if (iamRoleArn) {
    const roleName = orgBrokerRoleName(orgId)

    // First delete inline policies
    try {
      await iam.send(new DeleteRolePolicyCommand({
        RoleName: roleName,
        PolicyName: ORG_BROKER_POLICY_NAME,
      }))
    } catch (err) {
      logger.warn("Failed to delete IAM role policy (may not exist)", {
        orgId,
        roleName,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Then delete the role
    try {
      await iam.send(new DeleteRoleCommand({
        RoleName: roleName,
      }))
      logger.info("Deleted IAM role", { orgId, roleName })
    } catch (err) {
      logger.warn("Failed to delete IAM role", {
        orgId,
        roleName,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  logger.info("Org deprovisioning complete", { orgId })
}
