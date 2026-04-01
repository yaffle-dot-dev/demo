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

# =============================================================================
# ACM Certificate
# =============================================================================
# Wildcard certificate for yaffle.dev - used by all applications.
# Validation records are in Route53, same zone as the domain.
# =============================================================================

resource "aws_acm_certificate" "main" {
  domain_name       = var.domain
  validation_method = "DNS"

  subject_alternative_names = [
    "*.${var.domain}",
    "*.preview.${var.domain}",
  ]

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "${var.domain}-wildcard"
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = local.cert_domains

  allow_overwrite = true
  name            = local.cert_validation_records[each.key].name
  records         = [local.cert_validation_records[each.key].record]
  ttl             = 60
  type            = local.cert_validation_records[each.key].type
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

# Use static keys (domain names we know upfront) to avoid for_each unknown key errors.
# ACM creates one validation record per unique domain:
# - yaffle.dev + *.yaffle.dev share the same validation record
# - *.preview.yaffle.dev needs its own validation record (different subdomain level)
#
# We key by the base domain for lookups, but ACM uses the wildcard form in domain_validation_options.
locals {
  # Map base domains to their ACM domain_validation_options key
  cert_domain_mapping = {
    (var.domain)            = var.domain                # yaffle.dev -> yaffle.dev (shared with *.yaffle.dev)
    "preview.${var.domain}" = "*.preview.${var.domain}" # preview.yaffle.dev -> *.preview.yaffle.dev
  }

  cert_domains = toset(keys(local.cert_domain_mapping))

  cert_validation_records = {
    for domain in local.cert_domains : domain => {
      for dvo in aws_acm_certificate.main.domain_validation_options : dvo.domain_name => {
        name   = dvo.resource_record_name
        record = dvo.resource_record_value
        type   = dvo.resource_record_type
      }
    }[local.cert_domain_mapping[domain]]
  }
}

resource "cloudflare_dns_record" "cert_validation" {
  for_each = local.cert_domains

  zone_id = var.cloudflare_zone_id
  name    = trimsuffix(local.cert_validation_records[each.key].name, ".")
  content = trimsuffix(local.cert_validation_records[each.key].record, ".")
  type    = local.cert_validation_records[each.key].type
  ttl     = 60
  proxied = false
}

# -----------------------------------------------------------------------------
# NS Records - Route53 nameservers in Cloudflare for Multi DNS
# -----------------------------------------------------------------------------
# Cloudflare Multi DNS requires NS records pointing to Route53's nameservers.
# Route53 assigns 4 nameservers to each hosted zone.
# -----------------------------------------------------------------------------

resource "cloudflare_dns_record" "route53_ns" {
  count = 4

  zone_id = var.cloudflare_zone_id
  name    = var.domain
  type    = "NS"
  content = aws_route53_zone.main.name_servers[count.index]
  ttl     = 86400
  proxied = false
}


# =============================================================================
# Loops Email (m.yaffle.dev)
# =============================================================================
# Email sending via Loops uses Amazon SES under the hood.
# These records enable SPF, DKIM, and DMARC for the m.yaffle.dev subdomain.
# =============================================================================

locals {
  loops_dkim_keys = [
    "tpcry2ehdqyxgw73tumgtcboxnmd34ax",
    "h2rr6erlq2pij3snyaswwqredwgsx4bs",
    "wbae33kfygociw2z3n3rnexdyafr66hc",
  ]
}

# -----------------------------------------------------------------------------
# Route53 Records
# -----------------------------------------------------------------------------

# MX record for envelope subdomain (SES feedback)
resource "aws_route53_record" "loops_mx" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "envelope.m.${var.domain}"
  type    = "MX"
  ttl     = 86400
  records = ["10 feedback-smtp.us-east-1.amazonses.com"]
}

# SPF record for envelope subdomain
resource "aws_route53_record" "loops_spf" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "envelope.m.${var.domain}"
  type    = "TXT"
  ttl     = 86400
  records = ["v=spf1 include:amazonses.com ~all"]
}

# DMARC record for mail subdomain
resource "aws_route53_record" "loops_dmarc" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "_dmarc.m.${var.domain}"
  type    = "TXT"
  ttl     = 86400
  records = ["v=DMARC1; p=none;"]
}

# DKIM CNAME records (3 keys from SES)
resource "aws_route53_record" "loops_dkim" {
  for_each = toset(local.loops_dkim_keys)

  zone_id = aws_route53_zone.main.zone_id
  name    = "${each.value}._domainkey.m.${var.domain}"
  type    = "CNAME"
  ttl     = 86400
  records = ["${each.value}.dkim.amazonses.com"]
}

# -----------------------------------------------------------------------------
# Cloudflare Records (Dual DNS)
# -----------------------------------------------------------------------------

# MX record for envelope subdomain
resource "cloudflare_dns_record" "loops_mx" {
  zone_id  = var.cloudflare_zone_id
  name     = "envelope.m.${var.domain}"
  type     = "MX"
  ttl      = 86400
  priority = 10
  content  = "feedback-smtp.us-east-1.amazonses.com"
  proxied  = false
}

# SPF record for envelope subdomain
resource "cloudflare_dns_record" "loops_spf" {
  zone_id = var.cloudflare_zone_id
  name    = "envelope.m.${var.domain}"
  type    = "TXT"
  ttl     = 86400
  content = "v=spf1 include:amazonses.com ~all"
  proxied = false
}

# DMARC record for mail subdomain
resource "cloudflare_dns_record" "loops_dmarc" {
  zone_id = var.cloudflare_zone_id
  name    = "_dmarc.m.${var.domain}"
  type    = "TXT"
  ttl     = 86400
  content = "v=DMARC1; p=none;"
  proxied = false
}

# DKIM CNAME records (3 keys from SES)
resource "cloudflare_dns_record" "loops_dkim" {
  for_each = toset(local.loops_dkim_keys)

  zone_id = var.cloudflare_zone_id
  name    = "${each.value}._domainkey.m.${var.domain}"
  type    = "CNAME"
  ttl     = 86400
  content = "${each.value}.dkim.amazonses.com"
  proxied = false
}

# =============================================================================
# Fastmail Email (yaffle.dev)
# =============================================================================
# Primary email hosting via Fastmail for yaffle.dev domain.
# Includes MX, SPF, DKIM, DMARC, and autodiscovery records.
# =============================================================================

locals {
  fastmail_dkim_keys = ["fm1", "fm2", "fm3", "mesmtp"]

  fastmail_srv_records = {
    # Autodiscover
    "_autodiscover._tcp" = { priority = 0, weight = 1, port = 443, target = "autodiscover.fastmail.com" }
    # CalDAV
    "_caldav._tcp"  = { priority = 0, weight = 0, port = 0, target = "." }
    "_caldavs._tcp" = { priority = 0, weight = 1, port = 443, target = "d5923151.caldav.fastmail.com" }
    # CardDAV
    "_carddav._tcp"  = { priority = 0, weight = 0, port = 0, target = "." }
    "_carddavs._tcp" = { priority = 0, weight = 1, port = 443, target = "d5923151.carddav.fastmail.com" }
    # IMAP
    "_imap._tcp"  = { priority = 0, weight = 0, port = 0, target = "." }
    "_imaps._tcp" = { priority = 0, weight = 1, port = 993, target = "imap.fastmail.com" }
    # JMAP
    "_jmap._tcp" = { priority = 0, weight = 1, port = 443, target = "api.fastmail.com" }
    # POP3
    "_pop3._tcp"  = { priority = 0, weight = 0, port = 0, target = "." }
    "_pop3s._tcp" = { priority = 10, weight = 1, port = 995, target = "pop.fastmail.com" }
    # SMTP Submission
    "_submission._tcp"  = { priority = 0, weight = 0, port = 0, target = "." }
    "_submissions._tcp" = { priority = 0, weight = 1, port = 465, target = "smtp.fastmail.com" }
  }
}

# -----------------------------------------------------------------------------
# Route53 Records - Fastmail
# -----------------------------------------------------------------------------

# MX records for root domain
resource "aws_route53_record" "fastmail_mx" {
  zone_id = aws_route53_zone.main.zone_id
  name    = var.domain
  type    = "MX"
  ttl     = 3600
  records = [
    "10 in1-smtp.messagingengine.com",
    "20 in2-smtp.messagingengine.com",
  ]
}

# MX records for wildcard
resource "aws_route53_record" "fastmail_mx_wildcard" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "*.${var.domain}"
  type    = "MX"
  ttl     = 3600
  records = [
    "10 in1-smtp.messagingengine.com",
    "20 in2-smtp.messagingengine.com",
  ]
}

# MX records for mail subdomain
resource "aws_route53_record" "fastmail_mx_mail" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "mail.${var.domain}"
  type    = "MX"
  ttl     = 3600
  records = [
    "10 in1-smtp.messagingengine.com",
    "20 in2-smtp.messagingengine.com",
  ]
}

# A record for mail subdomain
resource "aws_route53_record" "fastmail_a_mail" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "mail.${var.domain}"
  type    = "A"
  ttl     = 3600
  records = ["103.168.172.65"]
}

# SPF record for root domain
resource "aws_route53_record" "fastmail_spf" {
  zone_id = aws_route53_zone.main.zone_id
  name    = var.domain
  type    = "TXT"
  ttl     = 3600
  records = ["v=spf1 include:spf.messagingengine.com ?all"]
}

# DMARC record for root domain
resource "aws_route53_record" "fastmail_dmarc" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "_dmarc.${var.domain}"
  type    = "TXT"
  ttl     = 3600
  records = ["v=DMARC1; p=none;"]
}

# DKIM CNAME records (Fastmail)
resource "aws_route53_record" "fastmail_dkim" {
  for_each = toset(local.fastmail_dkim_keys)

  zone_id = aws_route53_zone.main.zone_id
  name    = "${each.value}._domainkey.${var.domain}"
  type    = "CNAME"
  ttl     = 3600
  records = ["${each.value}.${var.domain}.dkim.fmhosted.com"]
}

# SRV records for autodiscovery and mail protocols
resource "aws_route53_record" "fastmail_srv" {
  for_each = local.fastmail_srv_records

  zone_id = aws_route53_zone.main.zone_id
  name    = "${each.key}.${var.domain}"
  type    = "SRV"
  ttl     = 3600
  records = ["${each.value.priority} ${each.value.weight} ${each.value.port} ${each.value.target}"]
}

# -----------------------------------------------------------------------------
# Cloudflare Records - Fastmail (Dual DNS)
# -----------------------------------------------------------------------------

# MX records for root domain
resource "cloudflare_dns_record" "fastmail_mx_primary" {
  zone_id  = var.cloudflare_zone_id
  name     = var.domain
  type     = "MX"
  ttl      = 3600
  priority = 10
  content  = "in1-smtp.messagingengine.com"
  proxied  = false
}

resource "cloudflare_dns_record" "fastmail_mx_secondary" {
  zone_id  = var.cloudflare_zone_id
  name     = var.domain
  type     = "MX"
  ttl      = 3600
  priority = 20
  content  = "in2-smtp.messagingengine.com"
  proxied  = false
}

# MX records for wildcard
resource "cloudflare_dns_record" "fastmail_mx_wildcard_primary" {
  zone_id  = var.cloudflare_zone_id
  name     = "*.${var.domain}"
  type     = "MX"
  ttl      = 3600
  priority = 10
  content  = "in1-smtp.messagingengine.com"
  proxied  = false
}

resource "cloudflare_dns_record" "fastmail_mx_wildcard_secondary" {
  zone_id  = var.cloudflare_zone_id
  name     = "*.${var.domain}"
  type     = "MX"
  ttl      = 3600
  priority = 20
  content  = "in2-smtp.messagingengine.com"
  proxied  = false
}

# MX records for mail subdomain
resource "cloudflare_dns_record" "fastmail_mx_mail_primary" {
  zone_id  = var.cloudflare_zone_id
  name     = "mail.${var.domain}"
  type     = "MX"
  ttl      = 3600
  priority = 10
  content  = "in1-smtp.messagingengine.com"
  proxied  = false
}

resource "cloudflare_dns_record" "fastmail_mx_mail_secondary" {
  zone_id  = var.cloudflare_zone_id
  name     = "mail.${var.domain}"
  type     = "MX"
  ttl      = 3600
  priority = 20
  content  = "in2-smtp.messagingengine.com"
  proxied  = false
}

# A record for mail subdomain
resource "cloudflare_dns_record" "fastmail_a_mail" {
  zone_id = var.cloudflare_zone_id
  name    = "mail.${var.domain}"
  type    = "A"
  ttl     = 3600
  content = "103.168.172.65"
  proxied = false
}

# SPF record for root domain
resource "cloudflare_dns_record" "fastmail_spf" {
  zone_id = var.cloudflare_zone_id
  name    = var.domain
  type    = "TXT"
  ttl     = 3600
  content = "v=spf1 include:spf.messagingengine.com ?all"
  proxied = false
}

# DMARC record for root domain
resource "cloudflare_dns_record" "fastmail_dmarc" {
  zone_id = var.cloudflare_zone_id
  name    = "_dmarc.${var.domain}"
  type    = "TXT"
  ttl     = 3600
  content = "v=DMARC1; p=none;"
  proxied = false
}

# DKIM CNAME records (Fastmail)
resource "cloudflare_dns_record" "fastmail_dkim" {
  for_each = toset(local.fastmail_dkim_keys)

  zone_id = var.cloudflare_zone_id
  name    = "${each.value}._domainkey.${var.domain}"
  type    = "CNAME"
  ttl     = 3600
  content = "${each.value}.${var.domain}.dkim.fmhosted.com"
  proxied = false
}

# SRV records for autodiscovery and mail protocols
resource "cloudflare_dns_record" "fastmail_srv" {
  for_each = local.fastmail_srv_records

  zone_id = var.cloudflare_zone_id
  name    = "${each.key}.${var.domain}"
  type    = "SRV"
  ttl     = 3600

  data = {
    priority = each.value.priority
    weight   = each.value.weight
    port     = each.value.port
    target   = each.value.target
  }

  # Cloudflare provider v5 moved priority into data block, but API still returns
  # it at top level. Ignore to prevent perpetual drift.
  lifecycle {
    ignore_changes = [priority]
  }
}
