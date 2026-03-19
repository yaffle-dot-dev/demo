# =============================================================================
# ECS Task Definition - Runner
# =============================================================================
# Isolated task definition for running tofu jobs.
#
# SECURITY: This task runs untrusted user code. It:
#   - Has minimal IAM permissions (see iam.tf)
#   - Has no secrets injected (all inputs via presigned URLs)
#   - Uses an isolated security group
#   - Runs in Fargate (no host access)
# =============================================================================

# -----------------------------------------------------------------------------
# CloudWatch Log Group
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "runner" {
  name              = "/ecs/yaffle-runner-${local.name_suffix}"
  retention_in_days = local.is_preview ? 3 : 14

  tags = {
    Name = "yaffle-runner-logs-${local.name_suffix}"
  }
}

# -----------------------------------------------------------------------------
# ECS Task Definition
# -----------------------------------------------------------------------------

resource "aws_ecs_task_definition" "runner" {
  family                   = "yaffle-runner-${local.name_suffix}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.runner_cpu
  memory                   = var.runner_memory
  execution_role_arn       = aws_iam_role.runner_execution.arn
  task_role_arn            = aws_iam_role.runner_task.arn

  # Fargate runtime - latest platform version
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([
    {
      name      = "runner"
      image     = "${local.ecr_runner_url}:latest"
      essential = true

      # Command is overridden at RunTask time with job-specific values
      # Default is just to show help/version
      command = ["--help"]

      # NO SECRETS - the runner does not have access to Yaffle secrets
      # All inputs come via environment variables set in containerOverrides

      # Minimal environment - just what the script needs
      environment = [
        { name = "AWS_DEFAULT_REGION", value = var.aws_region },
      ]

      # CloudWatch logging
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.runner.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "runner"
        }
      }

      # Resource limits
      ulimits = [
        {
          name      = "nofile"
          softLimit = 65536
          hardLimit = 65536
        }
      ]

      # No health check - the task runs to completion and exits
    }
  ])

  tags = {
    Name = "yaffle-runner-task-${local.name_suffix}"
  }
}
