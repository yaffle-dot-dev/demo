# =============================================================================
# Naming Module
# =============================================================================
# Provides consistent naming suffix for Yaffle-managed resources.
# Combines environment and region shortcode into a standard suffix.
#
# Usage:
#   module "naming" {
#     source      = "yaffle-dot-dev/naming/aws"
#     environment = var.environment
#     aws_region  = var.aws_region
#   }
#
#   resource "aws_s3_bucket" "state" {
#     bucket = "myproject-state-${module.naming.suffix}"
#     # → "myproject-state-main-use1"
#   }
# =============================================================================

terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 4.0"
    }
  }
}

module "region_codes" {
  source  = "cloudposse/utils/aws"
  version = "1.4.0"
}

locals {
  region_short = module.region_codes.region_az_alt_code_maps.to_short[var.aws_region]
  suffix       = "${var.environment}-${local.region_short}"
}
