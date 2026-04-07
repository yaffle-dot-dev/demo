# =============================================================================
# Bootstrap Module
# =============================================================================
# Creates the bare state bucket for a Yaffle environment.
#
# Usage (from this directory):
#   tofu init
#   tofu apply -var="environment=main"
#
# Creates minimal secure bucket (with public access block).
# The main workspace (apps/control-plane/infra/) imports this bucket and adds
# versioning, encryption, and lifecycle rules.
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

variable "environment_kind" {
  type        = string
  description = "Kind of environment ('named' or 'transient')"
}

variable "environment" {
  type        = string
  description = "Environment name (e.g. 'main', 'prvw-42')"
}

variable "aws_region" {
  type        = string
  description = "AWS region"
  default     = "us-east-1"
}

module "region_codes" {
  source = "../../../../../infra_modules/public/region_codes"
}

locals {
  region_short = module.region_codes.to_short[var.aws_region]
  bucket_name  = "yaffle-state-${var.environment}-${local.region_short}"
}

# -----------------------------------------------------------------------------
# State Bucket (bare minimum for bootstrap)
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "state" {
  bucket        = local.bucket_name
  force_destroy = var.environment_kind == "transient"

  tags = {
    Name                    = local.bucket_name
    "yaffle:resource-class" = "control-plane-state-storage"
  }
}

# Security baseline - always block public access
resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------

output "bucket_name" {
  value       = aws_s3_bucket.state.id
  description = "State bucket name"
}

output "bucket_arn" {
  value       = aws_s3_bucket.state.arn
  description = "State bucket ARN"
}
