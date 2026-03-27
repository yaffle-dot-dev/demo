# =============================================================================
# ALB Target Group & Listener Rule - Web App
# =============================================================================
# Routes /app/* traffic from the shared ALB to the web app ECS service.
# The ALB itself is owned by apps/control-plane/infra.
# =============================================================================

# -----------------------------------------------------------------------------
# Target Group
# -----------------------------------------------------------------------------

resource "aws_lb_target_group" "web" {
  name        = "yaffle-web-tg-${local.name_suffix}"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = local.vpc_id
  target_type = "ip"

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    path                = "/app/"
    matcher             = "200"
  }

  tags = {
    Name = "yaffle-web-tg-${local.name_suffix}"
  }
}

# -----------------------------------------------------------------------------
# Listener Rule
# -----------------------------------------------------------------------------

resource "aws_lb_listener_rule" "web" {
  listener_arn = local.https_listener_arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }

  condition {
    path_pattern {
      values = ["/app", "/app/*"]
    }
  }

  tags = {
    Name = "yaffle-web-rule-${local.name_suffix}"
  }
}
