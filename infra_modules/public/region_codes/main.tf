# =============================================================================
# Region Codes Module
# =============================================================================
# Static mapping of AWS region names to short codes.
# Replaces cloudposse/utils/aws to avoid runtime API calls.
#
# Usage:
#   module "region_codes" {
#     source = "../region_codes"
#   }
#
#   locals {
#     region_short = module.region_codes.to_short[var.aws_region]
#   }
# =============================================================================

terraform {
  required_version = ">= 1.0"
}

# Standard AWS region short codes (matches cloudposse/utils/aws format)
# Format: {region} => {short_code}
# Short codes use: direction + number (e.g., use1 = us-east-1)
locals {
  to_short = {
    # US regions
    "us-east-1"      = "use1"
    "us-east-2"      = "use2"
    "us-west-1"      = "usw1"
    "us-west-2"      = "usw2"

    # GovCloud
    "us-gov-east-1"  = "uge1"
    "us-gov-west-1"  = "ugw1"

    # Canada
    "ca-central-1"   = "cac1"
    "ca-west-1"      = "caw1"

    # Europe
    "eu-west-1"      = "euw1"
    "eu-west-2"      = "euw2"
    "eu-west-3"      = "euw3"
    "eu-central-1"   = "euc1"
    "eu-central-2"   = "euc2"
    "eu-north-1"     = "eun1"
    "eu-south-1"     = "eus1"
    "eu-south-2"     = "eus2"

    # Asia Pacific
    "ap-east-1"      = "ape1"
    "ap-south-1"     = "aps1"
    "ap-south-2"     = "aps2"
    "ap-northeast-1" = "apne1"
    "ap-northeast-2" = "apne2"
    "ap-northeast-3" = "apne3"
    "ap-southeast-1" = "apse1"
    "ap-southeast-2" = "apse2"
    "ap-southeast-3" = "apse3"
    "ap-southeast-4" = "apse4"
    "ap-southeast-5" = "apse5"

    # Middle East
    "me-south-1"     = "mes1"
    "me-central-1"   = "mec1"

    # Africa
    "af-south-1"     = "afs1"

    # South America
    "sa-east-1"      = "sae1"

    # Israel
    "il-central-1"   = "ilc1"
  }
}

output "to_short" {
  value       = local.to_short
  description = "Map of AWS region names to short codes"
}
