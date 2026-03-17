variable "site_name" {
  type        = string
  description = "Name of the static site (e.g., 'docs', 'blog')"
}

variable "github_oidc_provider_arn" {
  type        = string
  description = "ARN of the GitHub OIDC provider in AWS for GitHub Actions authentication"
}

variable "environment" {
  type        = string
  description = "Environment name - branch name (e.g., 'main') or preview (e.g., 'prvw-42')"
}

variable "environment_kind" {
  type = string
  description = "Environment kind (either 'named' or 'transient')"
}

variable "aws_region" {
  type        = string
  description = "AWS region for primary resources"
  default     = "us-east-1"
}

variable "replica_region" {
  type        = string
  description = "AWS region for S3 bucket replication"
  default     = "us-west-2"
}

module "naming" {
  source      = "../public/naming"
  environment = var.environment
  aws_region  = var.aws_region
}

module "naming_replica" {
  source      = "../public/naming"
  environment = var.environment
  aws_region  = var.replica_region
}

locals {
  # Naming: yaffle-{resource}-{suffix}
  # suffix = {environment}-{region_short} (e.g., "main-use1", "prvw-42-use1")
  name_suffix         = module.naming.suffix
  replica_name_suffix = module.naming_replica.suffix
}
