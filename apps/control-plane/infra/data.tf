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
  source = "yaffle.tail66f312.ts.net:6969/yaffle-dot-dev--yaffle/infra--shared/yaffle"
}

# -----------------------------------------------------------------------------
# Core Infrastructure (VPC, ECS cluster)
# -----------------------------------------------------------------------------
# Terraform requires static module sources, so we define both and select via count.

module "main" {
  count  = local.is_preview ? 0 : 1
  source = "yaffle.tail66f312.ts.net:6969/yaffle-dot-dev--yaffle/infra--production/yaffle"
}

module "nonprod" {
  count  = local.is_preview ? 1 : 0
  source = "yaffle.tail66f312.ts.net:6969/yaffle-dot-dev--yaffle/infra--nonprod/yaffle"
}

# -----------------------------------------------------------------------------
# Runner Infrastructure (ECS task definition, IAM roles)
# -----------------------------------------------------------------------------

module "runner" {
  source = "yaffle.tail66f312.ts.net:6969/yaffle-dot-dev--yaffle/apps--runner--infra/yaffle"
}

# -----------------------------------------------------------------------------
# Convenience Locals
# -----------------------------------------------------------------------------

locals {
  # Shared outputs (true singletons)
  route53_zone_id     = module.shared.route53_zone_id
  acm_certificate_arn = module.shared.acm_certificate_validated_arn

  # State bucket (defined in state-storage.tf)
  state_bucket_name = module.bootstrap.bucket_name
  state_bucket_arn  = module.bootstrap.bucket_arn

  # Core outputs (environment-specific) - select from whichever module is active
  _core = local.is_preview ? module.nonprod[0] : module.main[0]

  vpc_id             = local._core.vpc_id
  public_subnet_ids  = local._core.public_subnet_ids
  private_subnet_ids = local._core.private_subnet_ids
  ecs_cluster_arn    = local._core.ecs_cluster_arn
  ecs_cluster_name   = local._core.ecs_cluster_name

  runner_task_role_arn      = module.runner.task_role_arn
  runner_execution_role_arn = module.runner.execution_role_arn
}
