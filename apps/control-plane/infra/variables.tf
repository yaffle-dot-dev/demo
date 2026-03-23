variable "environment" {
  type        = string
  description = "Environment name - branch name (e.g., 'main') or preview (e.g., 'prvw-42')"
}

variable "environment_kind" {
  type        = string
  description = "Kind of environment ('named' or 'transient')"
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

variable "runner_api_url" {
  type        = string
  description = "Runner-reachable control plane API URL for ECS/local runners"
  default     = ""
}

variable "runner_tfc_api_host" {
  type        = string
  description = "Runner-reachable TFC-compatible API host used for backend state URLs"
  default     = ""
}

variable "control_plane_image" {
  type        = string
  description = "Docker image for the control plane container"
  default     = "ghcr.io/yaffle-dot-dev/yaffle/control-plane:latest"
}

variable "secrets_arn_prefix" {
  type        = string
  description = "ARN prefix for Secrets Manager secrets (e.g., 'arn:aws:secretsmanager:us-east-1:123456789:secret:yaffle')"
  default     = ""
}

data "aws_caller_identity" "current" {}

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

  is_preview = var.environment_kind == "transient"
  secrets_arn_prefix = var.secrets_arn_prefix != "" ? var.secrets_arn_prefix : "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:yaffle/${var.environment}"

  # API domain: api.yaffle.dev for production, api-{env}.preview.yaffle.dev for previews
  # Uses hyphen (not dot) to stay within *.preview.yaffle.dev wildcard cert coverage
  api_domain = local.is_preview ? "api-${var.environment}.preview.${var.domain}" : "api.${var.domain}"
}
