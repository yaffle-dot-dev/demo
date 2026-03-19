# =============================================================================
# Data Sources
# =============================================================================
# References to shared and core infrastructure via Yaffle module registry.
# =============================================================================

# -----------------------------------------------------------------------------
# Core Infrastructure (VPC, ECS cluster)
# -----------------------------------------------------------------------------
# Terraform requires static module sources, so we define both and select via count.

module "main" {
  count  = local.is_preview ? 0 : 1
  source = "yaffle.local:6969/yaffle-dot-dev--yaffle/infra--production/yaffle"
}

module "nonprod" {
  count  = local.is_preview ? 1 : 0
  source = "yaffle.local:6969/yaffle-dot-dev--yaffle/infra--nonprod/yaffle"
}

# -----------------------------------------------------------------------------
# Convenience Locals
# -----------------------------------------------------------------------------

locals {
  # Core outputs (environment-specific) - select from whichever module is active
  _core = local.is_preview ? module.nonprod[0] : module.main[0]

  vpc_id             = local._core.vpc_id
  private_subnet_ids = local._core.private_subnet_ids
  ecs_cluster_arn    = local._core.ecs_cluster_arn
  ecs_cluster_name   = local._core.ecs_cluster_name
  ecr_runner_url     = local._core.ecr_runner_url
}
