# =============================================================================
# IAM Roles & Policies - Runner
# =============================================================================
# Minimal, sandboxed IAM permissions for the runner.
#
# SECURITY: The runner executes untrusted user terraform code. It must NOT have:
#   - Access to Yaffle's database
#   - Access to Yaffle's secrets
#   - Ability to assume roles beyond what's needed for the specific job
#
# The runner ONLY has:
#   - Permissions to write CloudWatch logs (via execution role)
#   - Access to the yaffle-workspaces bucket (presigned URLs from CP)
#   - Ability to assume per-org runner roles (for BYOA)
# =============================================================================

# -----------------------------------------------------------------------------
# ECS Execution Role
# -----------------------------------------------------------------------------
# Used by ECS to pull images and write logs. This is NOT the task role.

resource "aws_iam_role" "runner_execution" {
  name = "yaffle-runner-exec-${local.name_suffix}"

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
    Name = "yaffle-runner-exec-${local.name_suffix}"
  }
}

resource "aws_iam_role_policy_attachment" "runner_execution" {
  role       = aws_iam_role.runner_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "runner_execution_tailscale_secret" {
  count = var.tailscale_enabled && local.tailscale_runner_authkey_secret_arn != null ? 1 : 0

  name = "tailscale-secret-access"
  role = aws_iam_role.runner_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
        ]
        Resource = [
          local.tailscale_runner_authkey_secret_arn,
        ]
      },
    ]
  })
}

# -----------------------------------------------------------------------------
# Runner Task Role
# -----------------------------------------------------------------------------
# Runtime permissions for the runner container itself.
# This role is INTENTIONALLY minimal - the runner should not have access
# to Yaffle infrastructure.

resource "aws_iam_role" "runner_task" {
  name = "yaffle-runner-task-${local.name_suffix}"

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
    Name = "yaffle-runner-task-${local.name_suffix}"
  }
}

# The runner uses presigned URLs for S3 access, so it doesn't need direct S3 permissions.
# This is intentional - presigned URLs scope access to specific objects and expire quickly.

# Allow assuming per-org runner roles (for BYOA - Bring Your Own AWS)
# These roles are created dynamically when an org is provisioned.
resource "aws_iam_role_policy" "runner_assume_org_roles" {
  name = "assume-org-roles"
  role = aws_iam_role.runner_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "AssumeOrgRunnerRoles"
        Effect   = "Allow"
        Action   = "sts:AssumeRole"
        Resource = "arn:aws:iam::*:role/yaffle-runner-org-*"
        # The org-specific role will have conditions on the external ID
        # to ensure only the right runner can assume it
      }
    ]
  })
}
