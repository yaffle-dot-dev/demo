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

module "naming" {
  source      = "../../public/naming"
  environment = var.environment
  aws_region  = var.aws_region
}

locals {
  # Consistent naming: yaffle-<resource>-<tier>-<env>-<region>
  # Uses public naming module for {env}-{region}, prepends tier
  name_suffix = "${var.tier}-${module.naming.suffix}"

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
