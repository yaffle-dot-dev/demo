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

variable "is_preview" {
  type        = bool
  description = "Is environment a preview (enables force_destroy)"
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

module "aws_utils" {
  source  = "cloudposse/utils/aws"
  version = "1.4.0"
}

locals {
  region_short = module.aws_utils.region_az_alt_code_maps.to_short[var.aws_region]
  bucket_name  = "yaffle-state-${var.environment}-${local.region_short}"
}

# -----------------------------------------------------------------------------
# State Bucket (bare minimum for bootstrap)
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "state" {
  bucket        = local.bucket_name
  force_destroy = var.is_preview

  tags = {
    Name = local.bucket_name
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
