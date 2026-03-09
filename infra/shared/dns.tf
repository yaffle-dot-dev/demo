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

# =============================================================================
# ACM Certificate
# =============================================================================
# Wildcard certificate for yaffle.dev - used by all applications.
# Validation records are in Route53, same zone as the domain.
# =============================================================================

resource "aws_acm_certificate" "main" {
  domain_name       = var.domain
  validation_method = "DNS"

  subject_alternative_names = ["*.${var.domain}"]

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "${var.domain}-wildcard"
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.main.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = aws_route53_zone.main.zone_id
}

resource "aws_acm_certificate_validation" "main" {
  certificate_arn         = aws_acm_certificate.main.arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]

  # Dual DNS: wait for both Route53 AND Cloudflare records before validating
  # AWS may query either DNS provider, so both must have the validation records
  depends_on = [
    aws_route53_record.cert_validation,
    cloudflare_dns_record.cert_validation,
  ]
}

# =============================================================================
# Cloudflare DNS (Dual DNS)
# =============================================================================
# yaffle.dev uses dual DNS - both Route53 and Cloudflare have the zone.
# ACM validation records must exist in both for reliable certificate validation.
# =============================================================================

# Dedupe by record name since yaffle.dev and *.yaffle.dev share the same validation record
locals {
  cf_cert_validation_grouped = {
    for dvo in aws_acm_certificate.main.domain_validation_options : dvo.resource_record_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }...
  }
  # Take first element from each group (they're identical anyway)
  cf_cert_validation_records = {
    for k, v in local.cf_cert_validation_grouped : k => v[0]
  }
}

resource "cloudflare_dns_record" "cert_validation" {
  for_each = local.cf_cert_validation_records

  zone_id = var.cloudflare_zone_id
  name    = each.value.name
  content = each.value.record
  type    = each.value.type
  ttl     = 60
  proxied = false
}
