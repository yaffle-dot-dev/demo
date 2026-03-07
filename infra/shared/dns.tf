# =============================================================================
# DNS - Route53 Hosted Zone
# =============================================================================
# Route53 hosts the zone for yaffle.dev.
# After applying, update Cloudflare (registrar) to use Route53 nameservers.
# =============================================================================

resource "aws_route53_zone" "main" {
  name = var.domain

  tags = {
    Name = var.domain
  }
}

# -----------------------------------------------------------------------------
# Placeholder records - will be replaced by ALB alias when control-plane deploys
# -----------------------------------------------------------------------------

resource "aws_route53_record" "apex" {
  zone_id = aws_route53_zone.main.zone_id
  name    = var.domain
  type    = "A"
  ttl     = 300
  records = ["1.2.3.4"] # placeholder - replaced by control-plane infra
}

resource "aws_route53_record" "www" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "www.${var.domain}"
  type    = "CNAME"
  ttl     = 300
  records = [var.domain]
}
