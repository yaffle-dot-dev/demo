# =============================================================================
# Data Sources
# =============================================================================
# References to shared and core infrastructure via Yaffle module registry.
#
# - Shared: Route53 zone, GitHub OIDC (true singletons, never previewed)
# - Core: VPC, ECS cluster (long-lived branches use infra/main, previews use infra/nonprod)
#
# Yaffle generates shim modules from workspace outputs, enabling cross-workspace
# references without hardcoded remote state configuration.
# =============================================================================

# -----------------------------------------------------------------------------
# Shared Infrastructure (Route53, OIDC - true singletons)
# -----------------------------------------------------------------------------

module "shared" {
  source = "yaffle.dev/yaffle-dot-dev/infra--shared/yaffle"
}

# -----------------------------------------------------------------------------
# Core Infrastructure (VPC, ECS cluster)
# -----------------------------------------------------------------------------
# Terraform requires static module sources, so we define both and select via count.

module "main" {
  count  = var.is_preview ? 0 : 1
  source = "yaffle.dev/yaffle-dot-dev/infra--main/yaffle"
}

module "nonprod" {
  count  = var.is_preview ? 1 : 0
  source = "yaffle.dev/yaffle-dot-dev/infra--nonprod/yaffle"
}

# -----------------------------------------------------------------------------
# Convenience Locals
# -----------------------------------------------------------------------------

locals {
  # Shared outputs (true singletons)
  route53_zone_id = module.shared.route53_zone_id

  # State bucket (defined in state-storage.tf)
  state_bucket_name = aws_s3_bucket.state.id
  state_bucket_arn  = aws_s3_bucket.state.arn

  # Core outputs (environment-specific) - select from whichever module is active
  _core = var.is_preview ? module.nonprod[0] : module.main[0]

  vpc_id             = local._core.vpc_id
  public_subnet_ids  = local._core.public_subnet_ids
  private_subnet_ids = local._core.private_subnet_ids
  ecs_cluster_arn    = local._core.ecs_cluster_arn
  ecs_cluster_name   = local._core.ecs_cluster_name
}
