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
  description = "AWS region for primary resources"
  default     = "us-east-1"
}

variable "domain" {
  type        = string
  description = "Base domain for the application (e.g., 'yaffle.dev')"
  default     = "yaffle.dev"
}

variable "replica_region" {
  type        = string
  description = "AWS region for replica bucket policies"
  default     = "us-west-2"
}

module "naming" {
  source      = "../../infra_modules/public/naming"
  environment = var.environment
  aws_region  = var.aws_region
}

locals {
  name_suffix = module.naming.suffix

  # Domain: yaffle.dev for production, {env}.preview.yaffle.dev for previews
  site_domain = var.is_preview ? "${var.environment}.preview.${var.domain}" : var.domain
}
