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

variable "module_registry_host" {
  type        = string
  description = "Hostname for the Yaffle Terraform module registry"
  default     = "yaffle.dev"
}

variable "reconcile_schedule_expression" {
  type        = string
  description = "EventBridge schedule for periodic drift reconciliation"
  default     = "rate(5 minutes)"
}

variable "api_lambda_timeout_seconds" {
  type        = number
  description = "Timeout for the command-handling Lambda"
  default     = 30
}

variable "reconcile_lambda_timeout_seconds" {
  type        = number
  description = "Timeout for the reconciliation Lambda"
  default     = 120
}

module "naming" {
  source      = "../../../infra_modules/public/naming"
  environment = var.environment
  aws_region  = var.aws_region
}

locals {
  name_suffix = module.naming.suffix
  is_preview  = var.environment_kind == "transient"
}
