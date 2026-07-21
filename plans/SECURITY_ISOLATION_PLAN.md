# Security Isolation Plan

> Per-org state isolation with dedicated KMS keys, IAM roles, and proper workspace naming.

## Overview

This plan addresses two issues:

1. **Workspace name collision bug** - `infra/shared` in Repo A collides with `infra/shared` in Repo B
2. **Multi-tenant security** - Customer state is not isolated (shared S3 bucket, shared IAM role)

## Goals

- Prevent cross-repo workspace collisions within an org
- Prevent cross-org state access (defense in depth)
- Per-org KMS encryption keys
- Per-org IAM roles for runners
- Automatic provisioning on org signup
- Graceful handling of provisioning failures

## Architecture

### State Storage Model

Single S3 bucket per Yaffle environment, path-separated by org:

```
s3://yaffle-state-{env}-{region}/
├── org-{uuid-1}/
│   ├── {workspace-uuid}/v1.tfstate
│   └── {workspace-uuid}/v2.tfstate
├── org-{uuid-2}/
│   └── {workspace-uuid}/v1.tfstate
```

### Isolation Mechanism

```
┌─────────────────────────────────────────────────────────────┐
│                    S3: yaffle-state-{env}                   │
├─────────────────────────────────────────────────────────────┤
│  org-{uuid-1}/*                   org-{uuid-2}/*            │
└─────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
┌─────────────────┐           ┌─────────────────┐
│ IAM Role:       │           │ IAM Role:       │
│ yaffle-runner-  │           │ yaffle-runner-  │
│ org-{uuid-1}    │           │ org-{uuid-2}    │
├─────────────────┤           ├─────────────────┤
│ S3: org-uuid-1/*│           │ S3: org-uuid-2/*│
│ KMS: key-uuid-1 │           │ KMS: key-uuid-2 │
└─────────────────┘           └─────────────────┘
```

### Workspace Naming

**Format:** `{repo}-{environment}-{branch}-{path}`

All components are slugified (special chars → `-`, lowercased).

**Examples:**

| Scenario                  | Environment  | Branch        | Result                                  |
| ------------------------- | ------------ | ------------- | --------------------------------------- |
| PR #42                    | `pr-42`      | `feature/foo` | `myrepo-pr-42-feature-foo-infra-shared` |
| Push to main (production) | `production` | `main`        | `myrepo-production-main-infra-shared`   |
| Push to main (staging)    | `staging`    | `main`        | `myrepo-staging-main-infra-shared`      |

The environment comes from `yaffle.toml` triggers, not derived from branch.

---

## Implementation

### Part 1: Workspace Naming Fix

**File: `src/db/queries/workspaces.ts`**

Replace `buildWorkspaceName` with new signature and delete helper functions:

```typescript
/**
 * Build a workspace name from components.
 * Format: {repo}-{environment}-{branch}-{workspace_path}
 *
 * All components are slugified (special chars replaced with `-`, lowercased).
 */
export function buildWorkspaceName(
  repo: string,
  environment: string,
  branch: string,
  workspacePath: string,
): string {
  const slugify = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")

  const repoName = repo.includes("/") ? repo.split("/")[1] : repo

  return [slugify(repoName), slugify(environment), slugify(branch), slugify(workspacePath)].join(
    "-",
  )
}
```

**Delete:** `buildPreviewWorkspaceName`, `buildBranchWorkspaceName`

**File: `src/lib/workspace-service.ts`**

1. Rename `ensureProductionWorkspace` → `ensureNamedWorkspace`
2. Add `environment: string` to options interface
3. Update both functions to use new `buildWorkspaceName(repo, environment, branch, workspacePath)`

**File: `src/lib/iac-engine.ts`**

Update calls to workspace service to pass `environmentName` from deployment record.

---

### Part 2: Schema Changes

**File: `src/db/schema.ts`** - Add to `organizations` table:

```typescript
kmsKeyArn: text("kms_key_arn"),
kmsKeyAlias: text("kms_key_alias"),
iamRoleArn: text("iam_role_arn"),
provisioningStatus: text("provisioning_status").default("pending").notNull(),
// 'pending' | 'provisioning' | 'active' | 'failed'
provisioningError: text("provisioning_error"),
provisioningAttempts: integer("provisioning_attempts").default(0).notNull(),
```

**Migration: `drizzle/0007_org_security_isolation.sql`**

```sql
ALTER TABLE organizations ADD COLUMN kms_key_arn TEXT;
ALTER TABLE organizations ADD COLUMN kms_key_alias TEXT;
ALTER TABLE organizations ADD COLUMN iam_role_arn TEXT;
ALTER TABLE organizations ADD COLUMN provisioning_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE organizations ADD COLUMN provisioning_error TEXT;
ALTER TABLE organizations ADD COLUMN provisioning_attempts INTEGER NOT NULL DEFAULT 0;

-- Existing orgs start as 'active' (will use shared resources until reprovisioned)
UPDATE organizations SET provisioning_status = 'active';
```

---

### Part 3: S3 Path Updates

**File: `src/db/queries/state-versions.ts`**

```typescript
// Old: {workspace_uuid}/v{serial}.tfstate
// New: org-{org_uuid}/{workspace_uuid}/v{serial}.tfstate
export function buildS3Key(orgId: string, workspaceId: string, serial: number): string {
  return `org-${orgId}/${workspaceId}/v${serial}.tfstate`
}
```

Update all callers to pass `orgId`.

---

### Part 4: Infrastructure Changes

**File: `apps/control-plane/infra/state-storage.tf`**

Change lifecycle retention from 90 → 30 days:

```hcl
noncurrent_version_expiration {
  noncurrent_days = 30  # Was 90
}
```

**File: `apps/control-plane/infra/iam.tf`**

Add provisioning permissions for control plane:

```hcl
resource "aws_iam_role_policy" "control_plane_provisioning" {
  name = "org-provisioning"
  role = aws_iam_role.control_plane_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "KMSManagement"
        Effect = "Allow"
        Action = [
          "kms:CreateKey",
          "kms:CreateAlias",
          "kms:DeleteAlias",
          "kms:ScheduleKeyDeletion",
          "kms:TagResource",
          "kms:PutKeyPolicy",
          "kms:DescribeKey"
        ]
        Resource = "*"
      },
      {
        Sid    = "IAMOrgRoles"
        Effect = "Allow"
        Action = [
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:PutRolePolicy",
          "iam:DeleteRolePolicy",
          "iam:TagRole",
          "iam:GetRole"
        ]
        Resource = "arn:aws:iam::*:role/yaffle-runner-org-*"
      },
      {
        Sid      = "AssumeOrgRoles"
        Effect   = "Allow"
        Action   = "sts:AssumeRole"
        Resource = "arn:aws:iam::*:role/yaffle-runner-org-*"
      }
    ]
  })
}
```

---

### Part 5: Provisioning Service

**New file: `src/lib/org-provisioning.ts`**

Uses AWS SDK (temporary, will move to Terraform for dogfooding):

```typescript
interface ProvisioningResult {
  kmsKeyArn: string
  kmsKeyAlias: string
  iamRoleArn: string
}

export async function provisionOrgResources(
  orgId: string,
  orgSlug: string,
): Promise<ProvisioningResult> {
  // 1. Create KMS key with alias: alias/yaffle-org-{uuid}
  // 2. Create IAM role: yaffle-runner-org-{uuid}
  //    - Trust: ECS tasks + control plane can assume
  //    - Policy: S3 access to org-{uuid}/* + KMS key usage
  // 3. Return ARNs
}

export async function deprovisionOrgResources(
  orgId: string,
  kmsKeyArn?: string,
  iamRoleArn?: string,
): Promise<void> {
  // Schedule KMS key deletion (7 day minimum)
  // Delete IAM role and policies
}
```

**KMS Key Policy:**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "YaffleControlPlaneAdmin",
      "Effect": "Allow",
      "Principal": { "AWS": "${control_plane_role_arn}" },
      "Action": "kms:*",
      "Resource": "*"
    },
    {
      "Sid": "OrgRunnerUsage",
      "Effect": "Allow",
      "Principal": { "AWS": "${org_runner_role_arn}" },
      "Action": ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"],
      "Resource": "*"
    }
  ]
}
```

**IAM Role Inline Policy:**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "S3StateAccess",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::yaffle-state-${env}/org-${org_id}/*"
    },
    {
      "Sid": "S3ListAccess",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::yaffle-state-${env}",
      "Condition": {
        "StringLike": { "s3:prefix": ["org-${org_id}/*"] }
      }
    },
    {
      "Sid": "KMSAccess",
      "Effect": "Allow",
      "Action": ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"],
      "Resource": "${org_kms_key_arn}"
    }
  ]
}
```

---

### Part 6: Provisioning Job Handler

**New file: `src/jobs/org-provision.ts`**

```typescript
const MAX_ATTEMPTS = 5

export async function handleOrgProvisionJob(job: Job): Promise<void> {
  const { orgId, orgSlug } = job.payload

  const org = await findOrgById(orgId)
  if (!org) throw new Error("Org not found")

  // Already done?
  if (org.provisioningStatus === "active") return

  // Too many failures?
  if (org.provisioningAttempts >= MAX_ATTEMPTS) {
    await updateOrg(orgId, {
      provisioningStatus: "failed",
      provisioningError: "Max attempts exceeded. Support has been notified.",
    })
    // TODO: Create incident / alert
    return
  }

  await updateOrg(orgId, {
    provisioningStatus: "provisioning",
    provisioningAttempts: org.provisioningAttempts + 1,
  })

  try {
    const result = await provisionOrgResources(orgId, orgSlug)

    await updateOrg(orgId, {
      kmsKeyArn: result.kmsKeyArn,
      kmsKeyAlias: result.kmsKeyAlias,
      iamRoleArn: result.iamRoleArn,
      provisioningStatus: "active",
      provisioningError: null,
    })
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)

    if (org.provisioningAttempts + 1 >= MAX_ATTEMPTS) {
      await updateOrg(orgId, {
        provisioningStatus: "failed",
        provisioningError: errorMessage,
      })
      // TODO: Create incident
    } else {
      await updateOrg(orgId, {
        provisioningStatus: "pending",
        provisioningError: errorMessage,
      })
      // Re-queue with exponential backoff
      throw err
    }
  }
}
```

---

### Part 7: Onboarding Flow Changes

**File: `src/db/queries/organizations.ts`**

In org creation, queue provisioning job:

```typescript
export async function createOrg(data: CreateOrgInput): Promise<Organization> {
  const org = await db
    .insert(organizations)
    .values({
      ...data,
      provisioningStatus: "pending",
    })
    .returning()

  // Queue async provisioning
  await createJob({
    orgId: org[0].id,
    jobType: "org_provision",
    payload: { orgId: org[0].id, orgSlug: org[0].slug },
  })

  return org[0]
}
```

**File: `src/lib/iac-engine.ts`**

Block runs for unprovisionned orgs:

```typescript
if (org.provisioningStatus !== "active") {
  return {
    success: false,
    command: job.jobType,
    output: "",
    errorMessage:
      org.provisioningStatus === "failed"
        ? "Organization provisioning failed. Support has been notified."
        : `Organization is ${org.provisioningStatus}. Please wait.`,
    durationMs: 0,
  }
}
```

---

### Part 8: Runner Changes

**File: `src/lib/local-runner.ts`**

Add STS AssumeRole for org-scoped credentials:

```typescript
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts"

async function assumeOrgRole(roleArn: string): Promise<Credentials> {
  const sts = new STSClient({})
  const response = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `yaffle-run-${Date.now()}`,
      DurationSeconds: 3600,
    }),
  )
  return response.Credentials!
}

// In run():
if (org.iamRoleArn) {
  const credentials = await assumeOrgRole(org.iamRoleArn)
  extraEnv = {
    ...extraEnv,
    AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
    AWS_SESSION_TOKEN: credentials.SessionToken,
  }
}
```

---

### Part 9: UI Updates (Future)

- Show `provisioningStatus` in org settings page
- States:
  - **Active**: Green check, no action needed
  - **Provisioning**: Spinner, "Setting up your workspace..."
  - **Failed**: Red alert, "Something went wrong. Support has been notified and will contact you shortly." + Retry button
- Block workspace creation when org not active

---

## Files Changed Summary

| File                               | Change Type | Description                              |
| ---------------------------------- | ----------- | ---------------------------------------- |
| `src/db/schema.ts`                 | Modify      | Add org security fields                  |
| `src/db/queries/workspaces.ts`     | Modify      | New `buildWorkspaceName`, delete helpers |
| `src/db/queries/state-versions.ts` | Modify      | Add orgId to `buildS3Key`                |
| `src/db/queries/organizations.ts`  | Modify      | Queue provisioning job on create         |
| `src/lib/workspace-service.ts`     | Modify      | Rename function, add environment param   |
| `src/lib/iac-engine.ts`            | Modify      | Check provisioning status                |
| `src/lib/local-runner.ts`          | Modify      | Add STS AssumeRole                       |
| `src/lib/org-provisioning.ts`      | **New**     | AWS resource provisioning                |
| `src/jobs/org-provision.ts`        | **New**     | Provisioning job handler                 |
| `infra/state-storage.tf`           | Modify      | 30-day retention                         |
| `infra/iam.tf`                     | Modify      | Add provisioning permissions             |
| `drizzle/0007_org_security.sql`    | **New**     | Migration                                |

---

## Decisions

| Decision         | Choice                              | Rationale                              |
| ---------------- | ----------------------------------- | -------------------------------------- |
| Storage model    | Single bucket, path-separated       | Simpler ops, IAM enforces isolation    |
| Encryption       | Per-org KMS CMK                     | True isolation, customer-specific keys |
| IAM              | Per-org role created at signup      | Defense in depth                       |
| Provisioning     | AWS SDK (temp), moving to Terraform | SDK for MVP, Terraform for dogfooding  |
| State versioning | 30-day retention                    | Balance recovery vs secret exposure    |
| Retry policy     | 5 attempts with exponential backoff | Then raise incident                    |
| Workspace naming | `{repo}-{env}-{branch}-{path}`      | Prevents all collision types           |

---

## Linear Issues

- YAF-50: Create S3 state bucket with lifecycle policy
- YAF-51: Create per-org KMS key provisioning
- YAF-52: Create per-org IAM role provisioning
- YAF-53: Integrate security provisioning into org onboarding flow
- YAF-54: Runner assumes per-org IAM role for state operations
- YAF-55+: Payment & billing (separate milestone)
- YAF-59+: Concurrency & rate limits (separate milestone)

---

## Future Work

- **BYOB (Bring Your Own Bucket)**: Enterprise customers store state in their own AWS account
- **Terraform provisioning**: Replace AWS SDK with Yaffle managing its own org provisioning
- **Secrets management integration**: SSM, Doppler, Infisical providers
