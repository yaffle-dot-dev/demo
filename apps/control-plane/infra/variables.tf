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

module "aws_utils" {
  source  = "cloudposse/utils/aws"
  version = "1.4.0"
}

locals {
  # Resource naming includes environment
  name_prefix = "yaffle-${var.environment}"

  # Region shortcodes from cloudposse/utils/aws
  region_short         = module.aws_utils.region_az_alt_code_maps.to_short[var.aws_region]
  replica_region_short = module.aws_utils.region_az_alt_code_maps.to_short[var.replica_region]

  # State bucket naming: yaffle-state-{environment}-{region}
  name_suffix = "${var.environment}-${local.region_short}"
}
