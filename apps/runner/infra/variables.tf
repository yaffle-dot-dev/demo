# =============================================================================
# Variables
# =============================================================================

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

variable "runner_cpu" {
  type        = number
  description = "CPU units for runner task (256 = 0.25 vCPU)"
  default     = 512
}

variable "runner_memory" {
  type        = number
  description = "Memory for runner task in MB"
  default     = 1024
}

# -----------------------------------------------------------------------------
# Naming
# -----------------------------------------------------------------------------

module "naming" {
  source      = "../../../infra_modules/public/naming"
  environment = var.environment
  aws_region  = var.aws_region
}

locals {
  name_suffix = module.naming.suffix
  is_preview  = var.environment_kind == "transient"
}
