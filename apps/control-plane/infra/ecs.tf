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
  name              = "/ecs/yaffle-cp-${local.name_suffix}"
  retention_in_days = local.is_preview ? 7 : 30

  tags = {
    Name                    = "yaffle-cp-logs-${local.name_suffix}"
    "yaffle:resource-class" = local.control_plane_resource_classes.logs
  }
}

# -----------------------------------------------------------------------------
# ECS Task Definition - Control Plane
# -----------------------------------------------------------------------------

resource "aws_ecs_task_definition" "control_plane" {
  family                   = "yaffle-cp-${local.name_suffix}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = local.is_preview ? 256 : 512
  memory                   = local.is_preview ? 512 : 1024
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.control_plane_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

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
        { name = "NODE_ENV", value = local.is_preview ? "development" : "production" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "YAFFLE_STATE_BUCKET", value = local.state_bucket_name },
        { name = "YAFFLE_WORKSPACE_CACHE_BUCKET", value = aws_s3_bucket.workspace_cache.id },
        { name = "YAFFLE_RUNNER_API_URL", value = "https://${local.internal_cp_domain}" },
        { name = "YAFFLE_RUNNER_TFC_API_HOST", value = local.internal_cp_domain },
        # Stripe
        { name = "STRIPE_PORTAL_CONFIGURATION_ID", value = local.stripe_portal_configuration_id },
        { name = "STRIPE_PRO_PRICE_ID", value = local.stripe_pricing.pro.price_id },
        { name = "STRIPE_TEAM_PRICE_ID", value = local.stripe_pricing.team.price_id },
        # Free tier limits
        { name = "YAFFLE_FREE_LIMIT_CONCURRENT_PREVIEWS", value = tostring(local.stripe_pricing.free_limits.concurrent_preview_branches) },
        { name = "YAFFLE_FREE_LIMIT_MONTHLY_PREVIEWS", value = tostring(local.stripe_pricing.free_limits.preview_creations_per_month) },
        { name = "YAFFLE_FREE_LIMIT_NAMED_ENVIRONMENTS", value = tostring(local.stripe_pricing.free_limits.named_environments) },
        # Auth
        { name = "BETTER_AUTH_URL", value = "https://${var.domain}" },
        { name = "TRUSTED_ORIGINS", value = "https://${var.domain}" },
        # Telemetry
        { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = "https://api.axiom.co" },
        # Runner spawner (ECS)
        { name = "YAFFLE_ECS_CLUSTER", value = local.ecs_cluster_arn },
        { name = "YAFFLE_ECS_TASK_DEFINITION", value = module.runner.task_definition_family },
        { name = "YAFFLE_ECS_SUBNETS", value = join(",", local.private_subnet_ids) },
        { name = "YAFFLE_ECS_SECURITY_GROUPS", value = module.runner.security_group_id },
        # Warm runners / hybrid burst
        { name = "YAFFLE_WARM_RUNNER_AUTO_LAUNCH_ENABLED", value = "true" },
        { name = "YAFFLE_WARM_RUNNER_AUTO_LAUNCH_MAX_RUNNERS_PER_ORG", value = "2" },
        { name = "YAFFLE_WARM_RUNNER_AUTO_LAUNCH_MAX_SLOTS", value = "2" },
        { name = "YAFFLE_WARM_RUNNER_LAUNCH_GRACE_MS", value = "45000" },
        { name = "YAFFLE_WARM_RUNNER_BURST_ENABLED", value = "true" },
        { name = "YAFFLE_WARM_RUNNER_BURST_AFTER_MS", value = "10000" },
        { name = "YAFFLE_WARM_RUNNER_HEARTBEAT_INTERVAL_MS", value = "10000" },
        { name = "YAFFLE_WARM_RUNNER_POLL_INTERVAL_MS", value = "1000" },
        { name = "YAFFLE_WARM_RUNNER_IDLE_SHUTDOWN_MS", value = "120000" },
        { name = "YAFFLE_WARM_RUNNER_STALE_AFTER_MS", value = "30000" },
        { name = "YAFFLE_WARM_RUNNER_EXCLUDED_WORKSPACES", value = "" },
        # Scanner Lambda
        { name = "YAFFLE_SCANNER_LAMBDA_FUNCTION", value = module.runner.scanner_lambda_function_name },
        # Control plane identity
        { name = "YAFFLE_CONTROL_PLANE_ROLE_ARN", value = aws_iam_role.control_plane_task.arn },
        # TFC backend
        { name = "YAFFLE_TFC_API_HOST", value = local.internal_cp_domain },
        { name = "YAFFLE_MODULE_SOURCE_ALLOWED_HOSTS", value = "yaffle.dev" },
      ]

      secrets = [
        { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
        { name = "GITHUB_APP_ID", valueFrom = aws_secretsmanager_secret.app["github-app-id"].arn },
        { name = "GITHUB_APP_PRIVATE_KEY", valueFrom = aws_secretsmanager_secret.app["github-app-private-key"].arn },
        { name = "GITHUB_WEBHOOK_SECRET", valueFrom = aws_secretsmanager_secret.app["github-webhook-secret"].arn },
        { name = "BETTER_AUTH_SECRET", valueFrom = aws_secretsmanager_secret.app["better-auth-secret"].arn },
        { name = "GITHUB_OAUTH_CLIENT_ID", valueFrom = aws_secretsmanager_secret.app["github-oauth-client-id"].arn },
        { name = "GITHUB_OAUTH_CLIENT_SECRET", valueFrom = aws_secretsmanager_secret.app["github-oauth-client-secret"].arn },
        { name = "OTEL_EXPORTER_OTLP_HEADERS", valueFrom = aws_secretsmanager_secret.app["otel-headers"].arn },
        { name = "STRIPE_API_KEY", valueFrom = local.stripe_api_key_secret_arn },
        { name = "STRIPE_WEBHOOK_SIGNING_SECRET", valueFrom = local.stripe_webhook_signing_secret_arn },
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
        command     = ["CMD-SHELL", "bun -e \"fetch('http://localhost:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }

      essential = true
    }
  ])

  tags = {
    Name                    = "yaffle-cp-task-${local.name_suffix}"
    "yaffle:resource-class" = local.control_plane_resource_classes.compute
  }
}

# -----------------------------------------------------------------------------
# ECS Service - Control Plane
# -----------------------------------------------------------------------------

resource "aws_ecs_service" "control_plane" {
  name            = "yaffle-cp-${local.name_suffix}"
  cluster         = local.ecs_cluster_arn
  task_definition = aws_ecs_task_definition.control_plane.arn
  desired_count   = local.is_preview ? 1 : 2
  launch_type     = "FARGATE"

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
  deployment_minimum_healthy_percent = local.is_preview ? 0 : 50
  deployment_maximum_percent         = 200

  # Enable ECS managed tags for cost allocation
  enable_ecs_managed_tags = true
  propagate_tags          = "TASK_DEFINITION"

  # Ignore changes to desired_count so autoscaling can manage it
  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener.https]

  tags = {
    Name                    = "yaffle-cp-svc-${local.name_suffix}"
    "yaffle:resource-class" = local.control_plane_resource_classes.compute
  }
}
