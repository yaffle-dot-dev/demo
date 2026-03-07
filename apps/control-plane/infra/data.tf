# =============================================================================
# Data Sources
# =============================================================================
# References to core infrastructure via remote state.
# Production uses infra/production, previews use infra/nonprod.
# =============================================================================

# -----------------------------------------------------------------------------
# Shared Infrastructure (state bucket, Route53)
# -----------------------------------------------------------------------------

data "terraform_remote_state" "shared" {
  backend = "s3"

  config = {
    bucket = "yaffle-state"
    key    = "shared/terraform.tfstate"
    region = "us-east-1"
  }
}

# -----------------------------------------------------------------------------
# Environment-Specific Infrastructure (VPC, ECS cluster)
# -----------------------------------------------------------------------------

data "terraform_remote_state" "core" {
  backend = "s3"

  config = {
    bucket = "yaffle-state"
    key    = "${local.is_production ? "production" : "nonprod"}/terraform.tfstate"
    region = "us-east-1"
  }
}

# -----------------------------------------------------------------------------
# Convenience Locals
# -----------------------------------------------------------------------------

locals {
  # Shared outputs
  state_bucket_name = data.terraform_remote_state.shared.outputs.state_bucket_name
  state_bucket_arn  = data.terraform_remote_state.shared.outputs.state_bucket_arn
  lock_table_name   = data.terraform_remote_state.shared.outputs.lock_table_name
  lock_table_arn    = data.terraform_remote_state.shared.outputs.lock_table_arn
  route53_zone_id   = data.terraform_remote_state.shared.outputs.route53_zone_id

  # Core outputs (environment-specific)
  vpc_id             = data.terraform_remote_state.core.outputs.vpc_id
  public_subnet_ids  = data.terraform_remote_state.core.outputs.public_subnet_ids
  private_subnet_ids = data.terraform_remote_state.core.outputs.private_subnet_ids
  ecs_cluster_arn    = data.terraform_remote_state.core.outputs.ecs_cluster_arn
  ecs_cluster_name   = data.terraform_remote_state.core.outputs.ecs_cluster_name
}
