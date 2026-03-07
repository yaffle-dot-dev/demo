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
  name = "${local.name_prefix}-ecs-execution"

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
    Name = "${local.name_prefix}-ecs-execution"
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
  name = "${local.name_prefix}-control-plane-task"

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
    Name = "${local.name_prefix}-control-plane-task"
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

# DynamoDB access for state locking
resource "aws_iam_role_policy" "control_plane_dynamodb" {
  name = "dynamodb-lock-access"
  role = aws_iam_role.control_plane_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:DeleteItem"
        ]
        Resource = local.lock_table_arn
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
          "ecs:StopTask"
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
          aws_iam_role.tf_runner_task.arn
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

# -----------------------------------------------------------------------------
# TF Runner Task Role
# -----------------------------------------------------------------------------
# Runtime permissions for terraform runner containers

resource "aws_iam_role" "tf_runner_task" {
  name = "${local.name_prefix}-tf-runner-task"

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
    Name = "${local.name_prefix}-tf-runner-task"
  }
}

# S3 access for state and workspaces
resource "aws_iam_role_policy" "tf_runner_s3" {
  name = "s3-access"
  role = aws_iam_role.tf_runner_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
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

# DynamoDB access for state locking
resource "aws_iam_role_policy" "tf_runner_dynamodb" {
  name = "dynamodb-lock-access"
  role = aws_iam_role.tf_runner_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:DeleteItem"
        ]
        Resource = local.lock_table_arn
      }
    ]
  })
}

# Secrets Manager access for TF variable injection
resource "aws_iam_role_policy" "tf_runner_secrets" {
  name = "secrets-access"
  role = aws_iam_role.tf_runner_task.id

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
