# =============================================================================
# Internal DNS - Private Hosted Zone
# =============================================================================
# Route53 private hosted zone for internal.yaffle.dev.
# Enables VPC-internal service communication with valid TLS.
#
# Services in the VPC resolve cp.internal.yaffle.dev to the ALB's private IP,
# keeping traffic off the public internet while using the ACM wildcard cert
# for *.internal.yaffle.dev.
# =============================================================================

resource "aws_route53_zone" "internal" {
  name = "internal.${var.domain}"

  vpc {
    vpc_id = local.vpc_id
  }

  # Prevent public resolution - this zone is VPC-only
  force_destroy = true

  tags = {
    Name = "internal.${var.domain}"
  }
}

# -----------------------------------------------------------------------------
# Control Plane - internal A record
# -----------------------------------------------------------------------------

resource "aws_route53_record" "cp_internal" {
  zone_id = aws_route53_zone.internal.zone_id
  name    = "cp.internal.${var.domain}"
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}
