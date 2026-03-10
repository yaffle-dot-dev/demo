variable "environment" {
  type        = string
  description = "Environment name - branch name (e.g., 'main') or preview (e.g., 'prvw-42')"
}

variable "is_preview" {
  type        = bool
  description = "Whether this is a preview environment (ephemeral, for PRs)"
  default     = false
}

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

variable "domain" {
  type        = string
  description = "Base domain for the application (e.g., 'yaffle.dev')"
  default     = "yaffle.dev"
}

variable "control_plane_image" {
  type        = string
  description = "Docker image for the control plane container"
  default     = "ghcr.io/yaffle-dot-dev/yaffle/control-plane:latest"
}

variable "secrets_arn_prefix" {
  type        = string
  description = "ARN prefix for Secrets Manager secrets (e.g., 'arn:aws:secretsmanager:us-east-1:123456789:secret:yaffle')"
}

module "naming" {
  source      = "../../../infra_modules/public/naming"
  environment = var.environment
  aws_region  = var.aws_region
}

module "naming_replica" {
  source      = "../../../infra_modules/public/naming"
  environment = var.environment
  aws_region  = var.replica_region
}

locals {
  # Naming: yaffle-{resource}-{suffix}
  # suffix = {environment}-{region_short} (e.g., "main-use1", "prvw-42-use1")
  name_suffix         = module.naming.suffix
  replica_name_suffix = module.naming_replica.suffix
}
