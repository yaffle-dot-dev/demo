# =============================================================================
# Data Sources
# =============================================================================
# References to shared and core infrastructure via Yaffle module registry.
# =============================================================================

# -----------------------------------------------------------------------------
# Shared Infrastructure (singleton credentials)
# -----------------------------------------------------------------------------

module "shared" {
  source = "${var.module_registry_host}/yaffle-dot-dev--yaffle/infra--shared/yaffle"
}

data "aws_ssm_parameter" "tailscale_layer_arn" {
  count = var.tailscale_enabled && local.tailscale_layer_ssm_parameter_arn != null ? 1 : 0
  name  = local.tailscale_layer_ssm_parameter_arn != null ? split(":parameter", local.tailscale_layer_ssm_parameter_arn)[1] : "/unused"
}

# -----------------------------------------------------------------------------
# Core Infrastructure (VPC, ECS cluster)
# -----------------------------------------------------------------------------
# Terraform requires static module sources, so we define both and select via count.

module "main" {
  count  = local.is_preview ? 0 : 1
  source = "${var.module_registry_host}/yaffle-dot-dev--yaffle/infra--production/yaffle"
}

module "nonprod" {
  count  = local.is_preview ? 1 : 0
  source = "${var.module_registry_host}/yaffle-dot-dev--yaffle/infra--nonprod/yaffle"
}

# -----------------------------------------------------------------------------
# Convenience Locals
# -----------------------------------------------------------------------------

locals {
  # Core outputs (environment-specific) - select from whichever module is active
  _core = local.is_preview ? module.nonprod[0] : module.main[0]

  vpc_id                              = local._core.vpc_id
  private_subnet_ids                  = local._core.private_subnet_ids
  ecs_cluster_arn                     = local._core.ecs_cluster_arn
  ecs_cluster_name                    = local._core.ecs_cluster_name
  tailscale_layer_ssm_parameter_arn   = try(module.shared.tailscale_layer_ssm_parameter_arn, null)
  tailscale_runner_authkey_secret_arn = try(module.shared.tailscale_runner_authkey_secret_arn, null)
}
