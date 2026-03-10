# =============================================================================
# Application Load Balancer
# =============================================================================
# ALB for routing traffic to the control plane ECS service.
# Handles TLS termination with ACM certificate.
# =============================================================================

# -----------------------------------------------------------------------------
# ALB
# -----------------------------------------------------------------------------

resource "aws_lb" "main" {
  name               = "yaffle-alb-${local.name_suffix}"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = local.public_subnet_ids

  enable_deletion_protection = !var.is_preview

  tags = {
    Name = "yaffle-alb-${local.name_suffix}"
  }
}

# -----------------------------------------------------------------------------
# Target Group
# -----------------------------------------------------------------------------

resource "aws_lb_target_group" "control_plane" {
  name        = "yaffle-cp-tg-${local.name_suffix}"
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
    path                = "/health"
    matcher             = "200"
  }

  tags = {
    Name = "yaffle-cp-tg-${local.name_suffix}"
  }
}

# -----------------------------------------------------------------------------
# Listeners
# -----------------------------------------------------------------------------

# HTTP listener - redirect to HTTPS
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# HTTPS listener
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = local.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.control_plane.arn
  }
}

# -----------------------------------------------------------------------------
# Route53 DNS
# -----------------------------------------------------------------------------

# DNS record for the ALB
# Production: api.yaffle.dev
# Preview: api-{env}.preview.yaffle.dev (e.g., api-pr-42.preview.yaffle.dev)
resource "aws_route53_record" "api" {
  zone_id = local.route53_zone_id
  name    = local.api_domain
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}
