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

  enable_deletion_protection = !local.is_preview

  tags = {
    Name                    = "yaffle-alb-${local.name_suffix}"
    "yaffle:resource-class" = local.control_plane_resource_classes.load_balancer
  }
}

resource "aws_lb" "internal" {
  name               = "yaffle-int-alb-${local.name_suffix}"
  internal           = true
  load_balancer_type = "application"
  security_groups    = [aws_security_group.internal_alb.id]
  subnets            = local.private_subnet_ids

  enable_deletion_protection = !local.is_preview

  tags = {
    Name                    = "yaffle-int-alb-${local.name_suffix}"
    "yaffle:resource-class" = local.control_plane_resource_classes.load_balancer
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
    path                = "/api/ready"
    matcher             = "200"
  }

  tags = {
    Name                    = "yaffle-cp-tg-${local.name_suffix}"
    "yaffle:resource-class" = local.control_plane_resource_classes.load_balancer
  }
}

resource "aws_lb_target_group" "control_plane_internal" {
  name        = "yaffle-cp-int-tg-${local.name_suffix}"
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
    path                = "/api/ready"
    matcher             = "200"
  }

  tags = {
    Name                    = "yaffle-cp-int-tg-${local.name_suffix}"
    "yaffle:resource-class" = local.control_plane_resource_classes.load_balancer
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

resource "aws_lb_listener" "internal_https" {
  load_balancer_arn = aws_lb.internal.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = local.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.control_plane_internal.arn
  }
}

# -----------------------------------------------------------------------------
# Route53 DNS
# -----------------------------------------------------------------------------
# api.yaffle.dev resolves to the ALB. Used as CloudFront origin (production)
# and directly by previews (which don't have CloudFront).

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

# Cloudflare dual DNS record
resource "cloudflare_dns_record" "api" {
  zone_id = local.cloudflare_zone_id
  name    = local.api_domain
  type    = "CNAME"
  content = aws_lb.main.dns_name
  ttl     = 1 # Auto TTL
  proxied = false
}
