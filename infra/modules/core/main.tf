# =============================================================================
# Core Infrastructure Module
# =============================================================================
# Shared VPC + ECS cluster infrastructure for Yaffle environments.
# Used by both production and nonprod tiers.
#
# Naming convention: yaffle-<resource>-<tier>-<env>-<region>
# Example: yaffle-vpc-production-main-use1
# =============================================================================

terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

module "aws_utils" {
  source  = "cloudposse/utils/aws"
  version = "1.4.0"
}

locals {
  region_short = module.aws_utils.region_az_alt_code_maps.to_short[var.aws_region]

  # Consistent naming: yaffle-<resource>-<tier>-<env>-<region>
  name_suffix = "${var.tier}-${var.environment}-${local.region_short}"

  # Number of AZs/NATs
  az_count  = 2
  nat_count = var.ha_nat ? local.az_count : 1
}

# -----------------------------------------------------------------------------
# Data Sources
# -----------------------------------------------------------------------------

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_ssm_parameter" "ecs_ami" {
  name = "/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id"
}
