variable "aws_region" {
  type        = string
  description = "AWS region for all resources"
  default     = "us-east-1"
}

variable "replica_region" {
  type        = string
  description = "AWS region for state bucket replication"
  default     = "us-west-2"
}

variable "environment" {
  type        = string
  description = "Environment name (e.g., production, staging)"
}

variable "domain" {
  type        = string
  description = "Base domain for the application"
  default     = "yaffle.dev"
}

module "aws_utils" {
  source  = "cloudposse/utils/aws"
  version = "1.4.0"
}

locals {
  region_short         = module.aws_utils.region_az_alt_code_maps.to_short[var.aws_region]
  replica_region_short = module.aws_utils.region_az_alt_code_maps.to_short[var.replica_region]
  name_suffix          = "${var.environment}-${local.region_short}"
}
