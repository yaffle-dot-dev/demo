# =============================================================================
# Data Sources
# =============================================================================
# References to shared infrastructure and app-specific infrastructure
# via Yaffle module registry.
# =============================================================================

# -----------------------------------------------------------------------------
# Shared Infrastructure (Route53, ACM - true singletons)
# -----------------------------------------------------------------------------

module "shared" {
  source = "yaffle.local:6969/yaffle-dot-dev/infra--shared/yaffle"
}

# -----------------------------------------------------------------------------
# App Infrastructure (S3 buckets)
# -----------------------------------------------------------------------------

module "marketing" {
  source = "yaffle.local:6969/yaffle-dot-dev/apps--marketing--infra/yaffle"
}

module "web" {
  source = "yaffle.local:6969/yaffle-dot-dev/apps--web--infra/yaffle"
}

module "docs" {
  source = "yaffle.local:6969/yaffle-dot-dev/apps--docs--infra/yaffle"
}

# -----------------------------------------------------------------------------
# Convenience Locals
# -----------------------------------------------------------------------------

locals {
  # Shared outputs (true singletons)
  route53_zone_id     = module.shared.route53_zone_id
  acm_certificate_arn = module.shared.acm_certificate_validated_arn

  # Marketing site buckets
  marketing_primary_bucket_domain = module.marketing.primary_bucket_regional_domain_name
  marketing_replica_bucket_domain = module.marketing.replica_bucket_regional_domain_name
  marketing_primary_bucket_arn    = module.marketing.primary_bucket_arn
  marketing_replica_bucket_arn    = module.marketing.replica_bucket_arn

  # Web app buckets
  web_primary_bucket_domain = module.web.primary_bucket_regional_domain_name
  web_replica_bucket_domain = module.web.replica_bucket_regional_domain_name
  web_primary_bucket_arn    = module.web.primary_bucket_arn
  web_replica_bucket_arn    = module.web.replica_bucket_arn

  # Docs site buckets
  docs_primary_bucket_domain = module.docs.primary_bucket_regional_domain_name
  docs_replica_bucket_domain = module.docs.replica_bucket_regional_domain_name
  docs_primary_bucket_arn    = module.docs.primary_bucket_arn
  docs_replica_bucket_arn    = module.docs.replica_bucket_arn
}
