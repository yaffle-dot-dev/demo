# =============================================================================
# Internal DNS - Private Hosted Zones
# =============================================================================
# Enables VPC-internal service communication with valid TLS.
#
# Hosted runners resolve canonical public hostnames to private ALB addresses via
# split-horizon DNS. User-authored module/backend hosts remain stable while
# traffic from inside the VPC stays off NAT.
# =============================================================================

resource "aws_route53_zone" "private_canonical" {
  count = local.is_preview ? 0 : 1

  name = var.domain

  vpc {
    vpc_id = local.vpc_id
  }

  force_destroy = true

  tags = {
    Name                    = "private.${var.domain}"
    "yaffle:resource-class" = local.control_plane_resource_classes.dns
  }
}

resource "aws_route53_record" "private_canonical_root" {
  count = local.is_preview ? 0 : 1

  zone_id = aws_route53_zone.private_canonical[0].zone_id
  name    = var.domain
  type    = "A"

  alias {
    name                   = aws_lb.internal.dns_name
    zone_id                = aws_lb.internal.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "private_canonical_api" {
  count = local.is_preview ? 0 : 1

  zone_id = aws_route53_zone.private_canonical[0].zone_id
  name    = local.api_domain
  type    = "A"

  alias {
    name                   = aws_lb.internal.dns_name
    zone_id                = aws_lb.internal.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_zone" "internal" {
  name = "internal.${var.domain}"

  vpc {
    vpc_id = local.vpc_id
  }

  # Prevent public resolution - this zone is VPC-only
  force_destroy = true

  tags = {
    Name                    = "internal.${var.domain}"
    "yaffle:resource-class" = local.control_plane_resource_classes.dns
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
    name                   = aws_lb.internal.dns_name
    zone_id                = aws_lb.internal.zone_id
    evaluate_target_health = true
  }
}
