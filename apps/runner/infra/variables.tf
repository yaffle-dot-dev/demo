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

variable "module_registry_host" {
  type        = string
  description = "Hostname for the Yaffle Terraform module registry"
  default     = "yaffle.dev"
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

variable "runner_image" {
  type        = string
  description = "Bootstrap Docker image for the runner container"
  default     = "870923192739.dkr.ecr.us-east-1.amazonaws.com/yaffle-runner-production@sha256:327224189b9808da82ccc91ab2a2219ba83e64ae9fcd7c9fa4ceb44ce994c413"
}

variable "tailscale_enabled" {
  type        = bool
  description = "Enable Tailscale sidecar for ECS runner to reach local control plane"
  default     = true
}

variable "tailscale_hostname" {
  type        = string
  description = "Hostname for runner nodes in the tailnet"
  default     = "yaffle-runner"
}

variable "tailscale_tags" {
  type        = list(string)
  description = "Advertised Tailscale tags for runner nodes"
  default     = ["tag:ecs-runner"]
}

variable "axiom_token" {
  type        = string
  description = "Axiom API token for scanner Lambda telemetry"
  default     = ""
  sensitive   = true
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
