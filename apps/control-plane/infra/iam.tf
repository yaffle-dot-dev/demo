# =============================================================================
# IAM Roles & Policies
# =============================================================================
# IAM roles for ECS task execution and task runtime permissions.
# =============================================================================

# -----------------------------------------------------------------------------
# ECS Execution Role
# -----------------------------------------------------------------------------
# Used by ECS to pull images, write logs, and fetch secrets

locals {
  control_plane_s3_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:PutObjectTagging",
          "s3:DeleteObject",
          "s3:ListBucket",
        ]
        Resource = [
          local.state_bucket_arn,
          "${local.state_bucket_arn}/*",
        ]
      },
    ]
  })

  control_plane_ecs_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecs:RunTask",
          "ecs:DescribeTasks",
          "ecs:StopTask",
          "ecs:TagResource",
        ]
        Resource = "*"
        Condition = {
          ArnEquals = {
            "ecs:cluster" = local.ecs_cluster_arn
          }
        }
      },
      {
        Effect = "Allow"
        Action = [
          "iam:PassRole",
        ]
        Resource = [
          aws_iam_role.ecs_execution.arn,
          local.runner_task_role_arn,
          local.runner_execution_role_arn,
        ]
      },
    ]
  })

  control_plane_lambda_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "lambda:InvokeFunction",
        ]
        Resource = module.runner.scanner_lambda_arn
      },
    ]
  })

  control_plane_secrets_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ]
        Resource = [
          "${local.secrets_arn_prefix}/*",
        ]
      },
    ]
  })

  control_plane_provisioning_policy = jsonencode({
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
          "kms:DescribeKey",
        ]
        Resource = "*"
      },
      {
        Sid    = "IAMOrgBrokerRoles"
        Effect = "Allow"
        Action = [
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:UpdateAssumeRolePolicy",
          "iam:PutRolePolicy",
          "iam:GetRolePolicy",
          "iam:DeleteRolePolicy",
          "iam:TagRole",
          "iam:GetRole",
        ]
        Resource = "arn:aws:iam::*:role/yaffle-org-broker-*"
      },
      {
        Sid      = "AssumeOrgBrokerRoles"
        Effect   = "Allow"
        Action   = "sts:AssumeRole"
        Resource = "arn:aws:iam::*:role/yaffle-org-broker-*"
      },
    ]
  })
}

resource "aws_iam_role" "ecs_execution" {
  name = "yaffle-ecs-exec-${local.name_suffix}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name = "yaffle-ecs-exec-${local.name_suffix}"
  }
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Allow fetching secrets from Secrets Manager
resource "aws_iam_role_policy" "ecs_execution_secrets" {
  name = "secrets-access"
  role = aws_iam_role.ecs_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Resource = [
          "${local.secrets_arn_prefix}/*",
          local.stripe_api_key_secret_arn,
          local.stripe_webhook_signing_secret_arn,
        ]
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# Control Plane Task Role
# -----------------------------------------------------------------------------
# Runtime permissions for the control plane container

resource "aws_iam_role" "control_plane_task" {
  name = "yaffle-cp-task-${local.name_suffix}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      },
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          AWS = ["arn:aws:iam::870923192739:user/alauni"]
        }
      }
    ]
  })

  tags = {
    Name = "yaffle-cp-task-${local.name_suffix}"
  }
}

resource "aws_iam_role" "control_plane_task_local_dev" {
  count = local.create_local_dev_role ? 1 : 0

  name = "yaffle-cp-task-nonprod-${module.naming.region_short}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      },
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          AWS = local.local_dev_assume_principal_arns
        }
      },
    ]
  })

  tags = {
    Name = "yaffle-cp-task-nonprod-${module.naming.region_short}"
  }
}

# S3 access for state storage
resource "aws_iam_role_policy" "control_plane_s3" {
  name = "s3-state-access"
  role = aws_iam_role.control_plane_task.id

  policy = local.control_plane_s3_policy
}

resource "aws_iam_role_policy" "control_plane_s3_local_dev" {
  count = local.create_local_dev_role ? 1 : 0

  name   = "s3-state-access"
  role   = aws_iam_role.control_plane_task_local_dev[0].id
  policy = local.control_plane_s3_policy
}

# ECS access for launching TF runner tasks
resource "aws_iam_role_policy" "control_plane_ecs" {
  name = "ecs-runner-access"
  role = aws_iam_role.control_plane_task.id

  policy = local.control_plane_ecs_policy
}

resource "aws_iam_role_policy" "control_plane_ecs_local_dev" {
  count = local.create_local_dev_role ? 1 : 0

  name   = "ecs-runner-access"
  role   = aws_iam_role.control_plane_task_local_dev[0].id
  policy = local.control_plane_ecs_policy
}

# Lambda access for invoking scanner function
resource "aws_iam_role_policy" "control_plane_lambda" {
  name   = "lambda-scanner-access"
  role   = aws_iam_role.control_plane_task.id
  policy = local.control_plane_lambda_policy
}

# Secrets Manager access for reading connection credentials
resource "aws_iam_role_policy" "control_plane_secrets" {
  name = "secrets-access"
  role = aws_iam_role.control_plane_task.id

  policy = local.control_plane_secrets_policy
}

resource "aws_iam_role_policy" "control_plane_secrets_local_dev" {
  count = local.create_local_dev_role ? 1 : 0

  name   = "secrets-access"
  role   = aws_iam_role.control_plane_task_local_dev[0].id
  policy = local.control_plane_secrets_policy
}

# Org provisioning: create per-org KMS keys and org broker roles
resource "aws_iam_role_policy" "control_plane_provisioning" {
  name = "org-provisioning"
  role = aws_iam_role.control_plane_task.id

  policy = local.control_plane_provisioning_policy
}

resource "aws_iam_role_policy" "control_plane_provisioning_local_dev" {
  count = local.create_local_dev_role ? 1 : 0

  name   = "org-provisioning"
  role   = aws_iam_role.control_plane_task_local_dev[0].id
  policy = local.control_plane_provisioning_policy
}

# -----------------------------------------------------------------------------
# TF Runner Roles
# -----------------------------------------------------------------------------
# Runner IAM roles are managed by apps/runner/infra.
# Referenced via module outputs in data.tf for PassRole permissions above.
