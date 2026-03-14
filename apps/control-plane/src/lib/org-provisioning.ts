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
} from "@aws-sdk/client-kms"
import {
  CreateRoleCommand,
  DeleteRoleCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
  IAMClient,
} from "@aws-sdk/client-iam"
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
  orgRunnerRoleArn: string,
): Promise<KmsKeyResult> {
  const config = getConfig()
  const kms = getKmsClient(config.region)

  const keyAlias = `alias/yaffle-org-${orgId}`

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
      Tags: [
        { TagKey: "Project", TagValue: "yaffle" },
        { TagKey: "OrgId", TagValue: orgId },
      ],
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

  // Set key policy - control plane can manage, org runner can encrypt/decrypt
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
        Sid: "OrgRunnerUsage",
        Effect: "Allow",
        Principal: { AWS: orgRunnerRoleArn },
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

// =============================================================================
// IAM Role Provisioning
// =============================================================================

async function createOrgIamRole(orgId: string): Promise<string> {
  const config = getConfig()
  const iam = getIamClient(config.region)

  const roleName = `yaffle-runner-org-${orgId}`

  // Trust policy - allow ECS tasks and control plane to assume
  const trustPolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: {
          Service: "ecs-tasks.amazonaws.com",
        },
        Action: "sts:AssumeRole",
      },
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
      Description: `Yaffle runner role for org ${orgId}`,
      Tags: [
        { Key: "Project", Value: "yaffle" },
        { Key: "OrgId", Value: orgId },
      ],
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

  // Initial inline policy - S3 access only (KMS access added after key creation)
  const inlinePolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "S3StateAccess",
        Effect: "Allow",
        Action: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
        ],
        Resource: `arn:aws:s3:::${config.stateBucket}/org-${orgId}/*`,
      },
      {
        Sid: "S3ListAccess",
        Effect: "Allow",
        Action: "s3:ListBucket",
        Resource: `arn:aws:s3:::${config.stateBucket}`,
        Condition: {
          StringLike: {
            "s3:prefix": [`org-${orgId}/*`],
          },
        },
      },
    ],
  })

  await iam.send(new PutRolePolicyCommand({
    RoleName: roleName,
    PolicyName: "state-access",
    PolicyDocument: inlinePolicy,
  }))

  logger.info("Created IAM role for org", {
    orgId,
    roleName,
    roleArn,
  })

  return roleArn
}

/**
 * Update org IAM role to include KMS key access.
 * Called after KMS key is created so we have the actual key ARN.
 */
async function updateOrgIamRoleWithKmsAccess(
  orgId: string,
  kmsKeyArn: string,
): Promise<void> {
  const config = getConfig()
  const iam = getIamClient(config.region)

  const roleName = `yaffle-runner-org-${orgId}`

  // Full policy - S3 access + KMS access
  const inlinePolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "S3StateAccess",
        Effect: "Allow",
        Action: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
        ],
        Resource: `arn:aws:s3:::${config.stateBucket}/org-${orgId}/*`,
      },
      {
        Sid: "S3ListAccess",
        Effect: "Allow",
        Action: "s3:ListBucket",
        Resource: `arn:aws:s3:::${config.stateBucket}`,
        Condition: {
          StringLike: {
            "s3:prefix": [`org-${orgId}/*`],
          },
        },
      },
      {
        Sid: "KMSAccess",
        Effect: "Allow",
        Action: [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:GenerateDataKey",
        ],
        Resource: kmsKeyArn,
      },
    ],
  })

  await iam.send(new PutRolePolicyCommand({
    RoleName: roleName,
    PolicyName: "state-access",
    PolicyDocument: inlinePolicy,
  }))

  logger.info("Updated IAM role with KMS access", {
    orgId,
    roleName,
    kmsKeyArn,
  })
}

// =============================================================================
// Main Provisioning Function
// =============================================================================

/**
 * Provision AWS resources for a new organization.
 *
 * Creates (in order):
 * 1. IAM role `yaffle-runner-org-{uuid}` (must exist before KMS key policy references it)
 * 2. KMS key with alias `alias/yaffle-org-{uuid}`
 * 3. Updates IAM role with KMS key access policy
 */
export async function provisionOrgResources(
  orgId: string,
  _orgSlug: string, // Reserved for future use (tags, descriptions)
): Promise<ProvisioningResult> {
  const config = getConfig()

  logger.info("Starting org provisioning", { orgId })

  // Create IAM role first (so we can reference it in KMS key policy)
  // Initially created without KMS access - we'll add that after key creation
  const iamRoleArn = await createOrgIamRole(orgId)

  // Create KMS key (now we have the real IAM role ARN to use in policy)
  const { keyArn, keyAlias } = await createOrgKmsKey(orgId, config.controlPlaneRoleArn, iamRoleArn)

  // Update IAM role with KMS key access
  await updateOrgIamRoleWithKmsAccess(orgId, keyArn)

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
    const roleName = `yaffle-runner-org-${orgId}`

    // First delete inline policies
    try {
      await iam.send(new DeleteRolePolicyCommand({
        RoleName: roleName,
        PolicyName: "state-access",
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
