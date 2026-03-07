# =============================================================================
# Data Sources
# =============================================================================
# References to core infrastructure via Yaffle module registry.
# Production uses infra/production, previews use infra/nonprod.
#
# Yaffle generates shim modules from workspace outputs, enabling cross-workspace
# references without hardcoded remote state configuration.
# =============================================================================

# -----------------------------------------------------------------------------
# Shared Infrastructure (state bucket, Route53)
# -----------------------------------------------------------------------------

module "shared" {
  source = "yaffle.dev/yaffle-dot-dev/infra--shared/yaffle"
}

# -----------------------------------------------------------------------------
# Environment-Specific Infrastructure (VPC, ECS cluster)
# -----------------------------------------------------------------------------
# Terraform requires static module sources, so we define both and select via count.

module "production" {
  count  = local.is_production ? 1 : 0
  source = "yaffle.dev/yaffle-dot-dev/infra--production/yaffle"
}

module "nonprod" {
  count  = local.is_production ? 0 : 1
  source = "yaffle.dev/yaffle-dot-dev/infra--nonprod/yaffle"
}

# -----------------------------------------------------------------------------
# Convenience Locals
# -----------------------------------------------------------------------------

locals {
  # Shared outputs
  state_bucket_name = module.shared.state_bucket_name
  state_bucket_arn  = module.shared.state_bucket_arn
  lock_table_name   = module.shared.lock_table_name
  lock_table_arn    = module.shared.lock_table_arn
  route53_zone_id   = module.shared.route53_zone_id

  # Core outputs (environment-specific) - select from whichever module is active
  _core = local.is_production ? module.production[0] : module.nonprod[0]

  vpc_id             = local._core.vpc_id
  public_subnet_ids  = local._core.public_subnet_ids
  private_subnet_ids = local._core.private_subnet_ids
  ecs_cluster_arn    = local._core.ecs_cluster_arn
  ecs_cluster_name   = local._core.ecs_cluster_name
}
