# =============================================================================
# Production Infrastructure
# =============================================================================
# VPC + ECS cluster for production workloads.
# Production workloads run on Fargate with HA NAT gateways and enhanced container insights.
# =============================================================================

module "core" {
  source = "../../infra_modules/private/core"

  tier        = "production"
  environment = var.environment
  aws_region  = var.aws_region
  vpc_cidr    = "10.0.0.0/16"

  # Production settings
  ha_nat             = true
  container_insights = "enhanced"
}
