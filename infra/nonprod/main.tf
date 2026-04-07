# =============================================================================
# Non-Production Infrastructure
# =============================================================================
# VPC + ECS cluster for preview environments.
# Preview workloads run on Fargate with a single NAT gateway and no container insights.
# =============================================================================

module "core" {
  source = "../../infra_modules/private/core"

  tier        = "nonprod"
  environment = var.environment
  aws_region  = var.aws_region
  vpc_cidr    = "10.1.0.0/16"

  # Nonprod settings - cost optimized networking
  ha_nat             = false
  container_insights = "disabled"
}
