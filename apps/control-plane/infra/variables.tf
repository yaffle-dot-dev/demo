variable "environment" {
  type        = string
  description = "Environment name (e.g., 'production', 'preview-pr-42')"
}

variable "aws_region" {
  type        = string
  description = "AWS region for all resources"
  default     = "us-east-1"
}

locals {
  # Normalize environment for resource naming
  # Production uses clean names, previews get prefixed
  is_production = var.environment == "production"
  
  # Resource naming: production gets clean names, previews get environment prefix
  name_prefix = local.is_production ? "yaffle" : "yaffle-${var.environment}"
  
  # S3 bucket names must be globally unique and lowercase
  state_bucket_name = "${local.name_prefix}-state"
  
  # DynamoDB table for state locking
  lock_table_name = "${local.name_prefix}-locks"
}
