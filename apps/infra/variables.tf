variable "environment" {
  type        = string
  description = "Environment name - branch name (e.g., 'main') or preview (e.g., 'pr-42')"
}

variable "environment_kind" {
  type        = string
  description = "Kind of environment ('named' or 'transient')"
  default     = "named"
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

variable "module_registry_host" {
  type        = string
  description = "Hostname for the Yaffle Terraform module registry"
  default     = "yaffle.dev"
}

variable "replica_region" {
  type        = string
  description = "AWS region for replica bucket policies"
  default     = "us-west-2"
}

variable "cloudflare_zone_id" {
  type        = string
  description = "Optional override for the Cloudflare zone ID; defaults to the shared workspace output"
  default     = null
}

module "naming" {
  source      = "../../infra_modules/public/naming"
  environment = var.environment
  aws_region  = var.aws_region
}

locals {
  name_suffix = module.naming.suffix
  is_preview  = var.environment_kind == "transient"

  # Domain: yaffle.dev for production, {env}.preview.yaffle.dev for previews
  site_domain = local.is_preview ? "${var.environment}.preview.${var.domain}" : var.domain
  site_aliases = local.is_preview ? [local.site_domain] : [local.site_domain, "www.${local.site_domain}"]
}
