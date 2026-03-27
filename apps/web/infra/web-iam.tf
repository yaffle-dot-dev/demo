# =============================================================================
# IAM Roles - Web App ECS
# =============================================================================

# -----------------------------------------------------------------------------
# ECS Execution Role
# -----------------------------------------------------------------------------
# Used by ECS to pull images and write logs

resource "aws_iam_role" "ecs_execution" {
  name = "yaffle-web-ecs-exec-${local.name_suffix}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = {
    Name = "yaffle-web-ecs-exec-${local.name_suffix}"
  }
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# -----------------------------------------------------------------------------
# Web App Task Role
# -----------------------------------------------------------------------------
# Runtime permissions for the web app container.
# The web app is a frontend — it needs minimal permissions.

resource "aws_iam_role" "web_task" {
  name = "yaffle-web-task-${local.name_suffix}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = {
    Name = "yaffle-web-task-${local.name_suffix}"
  }
}
