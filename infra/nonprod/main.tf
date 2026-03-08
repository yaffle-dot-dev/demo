# =============================================================================
# Non-Production Infrastructure
# =============================================================================
# VPC + ECS cluster for preview environments.
# Uses spot instances, single NAT gateway, no container insights.
# =============================================================================

module "core" {
  source = "../modules/core"

  tier        = "nonprod"
  environment = var.environment
  aws_region  = var.aws_region
  vpc_cidr    = "10.1.0.0/16"

  # Nonprod settings - cost optimized
  instance_types     = var.instance_types
  min_instances      = var.min_instances
  max_instances      = var.max_instances
  use_spot           = true
  ha_nat             = false
  container_insights = false
}
