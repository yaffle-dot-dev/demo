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
  source = "yaffle.tail66f312.ts.net:6969/yaffle-dot-dev--yaffle/infra--shared/yaffle"
}

# -----------------------------------------------------------------------------
# App Infrastructure (S3 buckets)
# -----------------------------------------------------------------------------

module "marketing" {
  source = "yaffle.tail66f312.ts.net:6969/yaffle-dot-dev--yaffle/apps--marketing--infra/yaffle"
}

module "docs" {
  source = "yaffle.tail66f312.ts.net:6969/yaffle-dot-dev--yaffle/apps--docs--infra/yaffle"
}

module "control_plane" {
  source = "yaffle.tail66f312.ts.net:6969/yaffle-dot-dev--yaffle/apps--control-plane--infra/yaffle"
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

  # Docs site buckets
  docs_primary_bucket_domain = module.docs.primary_bucket_regional_domain_name
  docs_replica_bucket_domain = module.docs.replica_bucket_regional_domain_name
  docs_primary_bucket_arn    = module.docs.primary_bucket_arn
  docs_replica_bucket_arn    = module.docs.replica_bucket_arn

  # Control plane ALB
  api_domain = module.control_plane.api_domain
}
