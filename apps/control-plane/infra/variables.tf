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

variable "module_registry_host" {
  type        = string
  description = "Hostname for the Yaffle Terraform module registry"
  default     = "yaffle.dev"
}


variable "control_plane_image" {
  type        = string
  description = "Bootstrap Docker image for the control plane container"
  default     = "870923192739.dkr.ecr.us-east-1.amazonaws.com/yaffle-control-plane-production@sha256:41c49a13b022b20308afc18b7996cb3f38167e45ee36da145e00629a8eae7801"
}

variable "secrets_arn_prefix" {
  type        = string
  description = "ARN prefix for Secrets Manager secrets (e.g., 'arn:aws:secretsmanager:us-east-1:123456789:secret:yaffle')"
  default     = ""
}

variable "local_dev_assume_principals" {
  type        = string
  description = "Comma-separated AWS principals allowed to assume the nonprod local-dev control-plane role"
  default     = ""
}

variable "private_beta_invites_required" {
  type        = bool
  description = "Whether first-org creation is gated behind a private beta invite"
  default     = false
}

variable "private_beta_operator_identifiers" {
  type        = string
  description = "Comma-separated operator emails and/or GitHub logins allowed to manage private beta invites"
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

  is_preview                      = var.environment_kind == "transient"
  secrets_arn_prefix              = var.secrets_arn_prefix != "" ? var.secrets_arn_prefix : "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:yaffle/${var.environment}"
  local_dev_assume_principal_arns = [for value in split(",", var.local_dev_assume_principals) : trimspace(value) if trimspace(value) != ""]
  create_local_dev_role           = var.environment == "main" && length(local.local_dev_assume_principal_arns) > 0
  site_domain                     = local.is_preview ? "${var.environment}.preview.${var.domain}" : var.domain
  auth_trusted_origins = join(",", distinct(compact([
    "https://${local.site_domain}",
    local.is_preview ? null : "https://www.${local.site_domain}",
    "https://${local.api_domain}",
  ])))

  # API domain: api.yaffle.dev for production, api-{env}.preview.yaffle.dev for previews
  # Uses hyphen (not dot) to stay within *.preview.yaffle.dev wildcard cert coverage
  api_domain = local.is_preview ? "api-${var.environment}.preview.${var.domain}" : "api.${var.domain}"

  # Internal domain: used by runners and web app to reach the CP within the VPC.
  # Resolves via Route53 private hosted zone → ALB, with valid TLS via ACM cert.
  internal_cp_domain = "cp.internal.${var.domain}"
}
