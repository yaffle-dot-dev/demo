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
  description = "AWS region for naming and bootstrap resources"
  default     = "us-east-1"
}

variable "module_registry_host" {
  type        = string
  description = "Hostname for the Yaffle Terraform module registry"
  default     = "yaffle.dev"
}
