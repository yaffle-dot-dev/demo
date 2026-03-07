# =============================================================================
# ECS Task Definition & Service - Control Plane
# =============================================================================
# The control plane ECS task and service.
# Uses the shared ECS cluster from core infrastructure.
# =============================================================================

# -----------------------------------------------------------------------------
# CloudWatch Log Group
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "control_plane" {
  name              = "/ecs/${local.name_prefix}/control-plane"
  retention_in_days = local.is_production ? 30 : 7

  tags = {
    Name = "${local.name_prefix}-control-plane-logs"
  }
}

# -----------------------------------------------------------------------------
# ECS Task Definition - Control Plane
# -----------------------------------------------------------------------------

resource "aws_ecs_task_definition" "control_plane" {
  family                   = "${local.name_prefix}-control-plane"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = local.is_production ? 512 : 256
  memory                   = local.is_production ? 1024 : 512
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.control_plane_task.arn

  container_definitions = jsonencode([
    {
      name  = "control-plane"
      image = var.control_plane_image
      
      portMappings = [
        {
          containerPort = 3000
          hostPort      = 3000
          protocol      = "tcp"
        }
      ]

      environment = [
        { name = "PORT", value = "3000" },
        { name = "NODE_ENV", value = local.is_production ? "production" : "development" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "STATE_BUCKET", value = local.state_bucket_name },
        { name = "LOCK_TABLE", value = local.lock_table_name },
        { name = "ECS_CLUSTER", value = local.ecs_cluster_name },
      ]

      secrets = [
        { name = "DATABASE_URL", valueFrom = "${var.secrets_arn_prefix}/database-url" },
        { name = "GITHUB_APP_ID", valueFrom = "${var.secrets_arn_prefix}/github-app-id" },
        { name = "GITHUB_APP_PRIVATE_KEY", valueFrom = "${var.secrets_arn_prefix}/github-app-private-key" },
        { name = "GITHUB_WEBHOOK_SECRET", valueFrom = "${var.secrets_arn_prefix}/github-webhook-secret" },
        { name = "BETTER_AUTH_SECRET", valueFrom = "${var.secrets_arn_prefix}/better-auth-secret" },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.control_plane.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "wget -q --spider http://localhost:3000/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }

      essential = true
    }
  ])

  tags = {
    Name = "${local.name_prefix}-control-plane"
  }
}

# -----------------------------------------------------------------------------
# ECS Service - Control Plane
# -----------------------------------------------------------------------------

resource "aws_ecs_service" "control_plane" {
  name            = "${local.name_prefix}-control-plane"
  cluster         = local.ecs_cluster_arn
  task_definition = aws_ecs_task_definition.control_plane.arn
  desired_count   = local.is_production ? 2 : 1
  launch_type     = local.is_production ? "FARGATE" : "FARGATE_SPOT"

  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.control_plane.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.control_plane.arn
    container_name   = "control-plane"
    container_port   = 3000
  }

  # Allow deployments to proceed even if desired count can't be reached
  deployment_configuration {
    minimum_healthy_percent = local.is_production ? 50 : 0
    maximum_percent         = 200
  }

  # Enable ECS managed tags for cost allocation
  enable_ecs_managed_tags = true
  propagate_tags          = "TASK_DEFINITION"

  # Ignore changes to desired_count so autoscaling can manage it
  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener.https]

  tags = {
    Name = "${local.name_prefix}-control-plane"
  }
}
