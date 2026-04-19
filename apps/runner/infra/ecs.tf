# =============================================================================
# ECS Task Definition - Runner
# =============================================================================
# Isolated task definition for running tofu jobs.
#
# SECURITY: This task runs untrusted user code. It:
#   - Has minimal IAM permissions (see iam.tf)
#   - Has no secrets injected (job-specific values injected at RunTask time)
#   - Uses an isolated security group (no ingress, open egress)
#   - Runs in Fargate (no host access)
#   - Communicates with the control plane via scoped job tokens (heartbeat, logs, state)
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

  container_definitions = jsonencode(concat(
    var.tailscale_enabled ? [
      {
        name      = "tailscale"
        image     = "ghcr.io/tailscale/tailscale:stable"
        essential = true

        environment = [
          { name = "TS_HOSTNAME", value = "${var.tailscale_hostname}-${local.name_suffix}" },
          { name = "TS_AUTH_ONCE", value = "true" },
          { name = "TS_USERSPACE", value = "true" },
          { name = "TS_STATE_DIR", value = "/tmp/tailscale" },
          { name = "TS_OUTBOUND_HTTP_PROXY_LISTEN", value = ":1055" },
          { name = "TS_LOCAL_ADDR_PORT", value = "127.0.0.1:9002" },
          { name = "TS_ENABLE_HEALTH_CHECK", value = "true" },
          { name = "TS_EXTRA_ARGS", value = "--advertise-tags=${join(",", var.tailscale_tags)}" },
        ]

        secrets = local.tailscale_runner_authkey_secret_arn != null ? [
          { name = "TS_AUTHKEY", valueFrom = "${local.tailscale_runner_authkey_secret_arn}:authkey::" },
        ] : []

        healthCheck = {
          command     = ["CMD-SHELL", "tailscale status >/dev/null 2>&1 || exit 1"]
          interval    = 10
          timeout     = 5
          retries     = 6
          startPeriod = 15
        }

        logConfiguration = {
          logDriver = "awslogs"
          options = {
            "awslogs-group"         = aws_cloudwatch_log_group.runner.name
            "awslogs-region"        = var.aws_region
            "awslogs-stream-prefix" = "tailscale"
          }
        }
      },
    ] : [],
    [
      {
        name      = "runner"
        image     = var.runner_image
        essential = true

        dependsOn = var.tailscale_enabled ? [
          {
            containerName = "tailscale"
            condition     = "HEALTHY"
          },
        ] : []

        # Minimal environment - job-specific values are injected at RunTask time.
        environment = concat([
          { name = "AWS_DEFAULT_REGION", value = var.aws_region },
          ], var.tailscale_enabled ? [
          { name = "HTTP_PROXY", value = "http://127.0.0.1:1055" },
          { name = "HTTPS_PROXY", value = "http://127.0.0.1:1055" },
          { name = "NO_PROXY", value = "127.0.0.1,localhost,169.254.169.254,169.254.170.2" },
        ] : [])

        logConfiguration = {
          logDriver = "awslogs"
          options = {
            "awslogs-group"         = aws_cloudwatch_log_group.runner.name
            "awslogs-region"        = var.aws_region
            "awslogs-stream-prefix" = "runner"
          }
        }

        ulimits = [
          {
            name      = "nofile"
            softLimit = 65536
            hardLimit = 65536
          }
        ]
      },
    ],
  ))

  tags = {
    Name = "yaffle-runner-task-${local.name_suffix}"
  }
}
