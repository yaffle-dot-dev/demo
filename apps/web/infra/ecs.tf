# =============================================================================
# ECS Task Definition & Service - Web App
# =============================================================================
# SvelteKit SSR web application running as a separate ECS service.
# Routes traffic via the shared ALB from control-plane infra.
# =============================================================================

# -----------------------------------------------------------------------------
# CloudWatch Log Group
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "web" {
  name              = "/ecs/yaffle-web-${local.name_suffix}"
  retention_in_days = var.is_preview ? 7 : 30

  tags = {
    Name = "yaffle-web-logs-${local.name_suffix}"
  }
}

# -----------------------------------------------------------------------------
# ECS Task Definition
# -----------------------------------------------------------------------------

resource "aws_ecs_task_definition" "web" {
  family                   = "yaffle-web-${local.name_suffix}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.is_preview ? 256 : 256
  memory                   = var.is_preview ? 512 : 512
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.web_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([
    {
      name  = "web"
      image = var.web_image

      portMappings = [
        {
          containerPort = 3000
          hostPort      = 3000
          protocol      = "tcp"
        }
      ]

      environment = [
        { name = "PORT", value = "3000" },
        { name = "NODE_ENV", value = var.is_preview ? "development" : "production" },
        { name = "ORIGIN", value = "https://${var.domain}" },
        { name = "YAFFLE_API_URL", value = "https://${module.control_plane.internal_domain}" },
        # Stripe pricing (runtime vars for SvelteKit $env/dynamic/public)
        { name = "PUBLIC_STRIPE_PRO_PRICE_ID", value = module.shared.stripe_pricing.pro.price_id },
        { name = "PUBLIC_STRIPE_PRO_AMOUNT", value = tostring(module.shared.stripe_pricing.pro.amount) },
        { name = "PUBLIC_STRIPE_TEAM_PRICE_ID", value = module.shared.stripe_pricing.team.price_id },
        { name = "PUBLIC_STRIPE_TEAM_AMOUNT", value = tostring(module.shared.stripe_pricing.team.amount) },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.web.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "bun -e \"fetch('http://localhost:3000/app/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }

      essential = true
    }
  ])

  tags = {
    Name = "yaffle-web-task-${local.name_suffix}"
  }
}

# -----------------------------------------------------------------------------
# ECS Service
# -----------------------------------------------------------------------------

resource "aws_ecs_service" "web" {
  name            = "yaffle-web-${local.name_suffix}"
  cluster         = local.ecs_cluster_arn
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = var.is_preview ? 1 : 2
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.web.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }

  deployment_minimum_healthy_percent = var.is_preview ? 0 : 50
  deployment_maximum_percent         = 200

  enable_ecs_managed_tags = true
  propagate_tags          = "TASK_DEFINITION"

  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener_rule.web]

  tags = {
    Name = "yaffle-web-svc-${local.name_suffix}"
  }
}
