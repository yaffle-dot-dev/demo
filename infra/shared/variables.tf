variable "aws_region" {
  type        = string
  description = "AWS region for all resources"
  default     = "us-east-1"
}

variable "domain" {
  type        = string
  description = "Base domain for the application"
  default     = "yaffle.dev"
}

# Yaffle passes environment to all workspaces. Shared infra doesn't use it
# (it's a true singleton), but we declare it to avoid warnings.
variable "environment" {
  type        = string
  description = "Environment name (unused in shared, but passed by Yaffle)"
}

variable "environment_kind" {
  type        = string
  description = "Environment kind (unused in shared, but passed by Yaffle)"
  default     = "production"
}

variable "cloudflare_zone_id" {
  type        = string
  description = "Cloudflare zone ID for yaffle.dev (dual DNS setup)"
}

variable "stripe_webhook_url" {
  type        = string
  description = "URL for Stripe webhook endpoint (e.g. Smee proxy for dev, public URL for prod)"
}

variable "yaffle_app_url" {
  type        = string
  description = "Public URL of the Yaffle web app (for Stripe portal return URL)"
  default     = "https://yaffle.dev"
}

variable "tailscale_runner_tags" {
  type        = list(string)
  description = "Tags allowed for ECS runner Tailscale nodes"
  default     = ["tag:ecs-runner"]
}

variable "tailscale_github_actions_tags" {
  type        = list(string)
  description = "Tags allowed for GitHub Actions ephemeral Tailscale nodes"
  default     = ["tag:ci-runner"]
}

variable "deployer_principal_arns" {
  type        = list(string)
  description = "AWS principals allowed to assume the shared human deployer roles"
  default     = ["arn:aws:iam::870923192739:user/alauni"]
}

variable "self_hosted_org_broker_role_arn" {
  type        = string
  description = "Dogfood org broker role ARN trusted by the self-hosted execution roles"
  default     = "arn:aws:iam::870923192739:role/yaffle-org-broker-019d174b-c7cd-722d-8b09-73411e0613e0"

  validation {
    condition     = can(regex("^arn:aws(-[a-z]+)?:iam::[0-9]{12}:role/.+$", var.self_hosted_org_broker_role_arn))
    error_message = "self_hosted_org_broker_role_arn must be a valid IAM role ARN."
  }
}

variable "self_hosted_main_execution_role_name" {
  type        = string
  description = "Dogfood execution role name for the main environment"
  default     = "yaffle-assume-role-main-use1"

  validation {
    condition     = can(regex("^[A-Za-z0-9+=,.@_-]{1,64}$", var.self_hosted_main_execution_role_name))
    error_message = "self_hosted_main_execution_role_name must be a valid IAM role name (1-64 chars)."
  }
}

variable "self_hosted_non_main_execution_role_name" {
  type        = string
  description = "Dogfood execution role name shared by non-main environments"
  default     = "yaffle-assume-role-non-main-use1"

  validation {
    condition     = can(regex("^[A-Za-z0-9+=,.@_-]{1,64}$", var.self_hosted_non_main_execution_role_name))
    error_message = "self_hosted_non_main_execution_role_name must be a valid IAM role name (1-64 chars)."
  }
}

variable "self_hosted_main_external_id" {
  type        = string
  description = "External ID required to assume the dogfood main execution role"
  default     = "yaffle-yaffle-dot-dev-main-291y5h"

  validation {
    condition     = length(trimspace(var.self_hosted_main_external_id)) > 0
    error_message = "self_hosted_main_external_id must not be empty."
  }
}

variable "self_hosted_non_main_external_id" {
  type        = string
  description = "External ID required to assume the dogfood non-main execution role"
  default     = "yaffle-yaffle-dot-dev-main-kkinn1"

  validation {
    condition     = length(trimspace(var.self_hosted_non_main_external_id)) > 0
    error_message = "self_hosted_non_main_external_id must not be empty."
  }
}

variable "self_hosted_main_managed_policy_arns" {
  type        = list(string)
  description = "Managed policies attached to the dogfood main execution role"
  default     = ["arn:aws:iam::aws:policy/AdministratorAccess"]
}

variable "self_hosted_non_main_managed_policy_arns" {
  type        = list(string)
  description = "Managed policies attached to the dogfood non-main execution role"
  default     = ["arn:aws:iam::aws:policy/AdministratorAccess"]
}

variable "self_hosted_non_main_permissions_boundary_name" {
  type        = string
  description = "Managed policy name for the non-main execution permissions boundary"
  default     = "yaffle-non-main-execution-boundary"

  validation {
    condition     = can(regex("^[A-Za-z0-9+=,.@_-]{1,128}$", var.self_hosted_non_main_permissions_boundary_name))
    error_message = "self_hosted_non_main_permissions_boundary_name must be a valid IAM policy name."
  }
}
