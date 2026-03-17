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
}

module "region_codes" {
  source = "../region_codes"
}

locals {
  region_short = module.region_codes.to_short[var.aws_region]
  suffix       = "${var.environment}-${local.region_short}"
}
