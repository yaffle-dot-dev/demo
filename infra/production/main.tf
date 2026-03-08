# =============================================================================
# Production Infrastructure
# =============================================================================
# VPC + ECS cluster for production workloads.
# Uses on-demand instances, HA NAT gateways, container insights.
# =============================================================================

module "core" {
  source = "../modules/core"

  tier        = "production"
  environment = var.environment
  aws_region  = var.aws_region
  vpc_cidr    = "10.0.0.0/16"

  # Production settings
  instance_types     = [var.instance_type]
  min_instances      = var.min_instances
  max_instances      = var.max_instances
  use_spot           = false
  ha_nat             = true
  container_insights = true
}
