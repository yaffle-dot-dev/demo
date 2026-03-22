# =============================================================================
# IAM Roles & Policies
# =============================================================================
# IAM roles for ECS task execution and task runtime permissions.
# =============================================================================

# -----------------------------------------------------------------------------
# ECS Execution Role
# -----------------------------------------------------------------------------
# Used by ECS to pull images, write logs, and fetch secrets

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
          "${var.secrets_arn_prefix}/*"
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
      }
    ]
  })

  tags = {
    Name = "yaffle-cp-task-${local.name_suffix}"
  }
}

# S3 access for state storage
resource "aws_iam_role_policy" "control_plane_s3" {
  name = "s3-state-access"
  role = aws_iam_role.control_plane_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:PutObjectTagging",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          local.state_bucket_arn,
          "${local.state_bucket_arn}/*"
        ]
      }
    ]
  })
}

# ECS access for launching TF runner tasks
resource "aws_iam_role_policy" "control_plane_ecs" {
  name = "ecs-runner-access"
  role = aws_iam_role.control_plane_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecs:RunTask",
          "ecs:DescribeTasks",
          "ecs:StopTask",
          "ecs:TagResource"
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
          "iam:PassRole"
        ]
        Resource = [
          aws_iam_role.ecs_execution.arn,
          local.runner_task_role_arn,
          local.runner_execution_role_arn
        ]
      }
    ]
  })
}

# Secrets Manager access for reading connection credentials
resource "aws_iam_role_policy" "control_plane_secrets" {
  name = "secrets-access"
  role = aws_iam_role.control_plane_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret"
        ]
        Resource = [
          "${var.secrets_arn_prefix}/*"
        ]
      }
    ]
  })
}

# Org provisioning: create per-org KMS keys and org broker roles
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
          "iam:GetRole"
        ]
        Resource = "arn:aws:iam::*:role/yaffle-org-broker-*"
      },
      {
        Sid      = "AssumeOrgBrokerRoles"
        Effect   = "Allow"
        Action   = "sts:AssumeRole"
        Resource = "arn:aws:iam::*:role/yaffle-org-broker-*"
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# TF Runner Roles
# -----------------------------------------------------------------------------
# Runner IAM roles are managed by apps/runner/infra.
# Referenced via module outputs in data.tf for PassRole permissions above.
