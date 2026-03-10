# =============================================================================
# Data Sources
# =============================================================================
# References to shared infrastructure via Yaffle module registry.
#
# - Shared: Route53 zone, ACM certificate (true singletons, never previewed)
#
# Yaffle generates shim modules from workspace outputs, enabling cross-workspace
# references without hardcoded remote state configuration.
# =============================================================================

# -----------------------------------------------------------------------------
# Shared Infrastructure (Route53, ACM - true singletons)
# -----------------------------------------------------------------------------

module "shared" {
  source = "yaffle.local:6969/yaffle-dot-dev/infra--shared/yaffle"
}

# -----------------------------------------------------------------------------
# Convenience Locals
# -----------------------------------------------------------------------------

locals {
  # Shared outputs (true singletons)
  route53_zone_id     = module.shared.route53_zone_id
  acm_certificate_arn = module.shared.acm_certificate_validated_arn
}
