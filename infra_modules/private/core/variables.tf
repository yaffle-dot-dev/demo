# =============================================================================
# Core Infrastructure Module - Variables
# =============================================================================

variable "tier" {
  type        = string
  description = "Infrastructure tier: 'production' or 'nonprod'"

  validation {
    condition     = contains(["production", "nonprod"], var.tier)
    error_message = "Tier must be 'production' or 'nonprod'."
  }
}

variable "environment" {
  type        = string
  description = "Environment name (branch name, e.g. 'main')"
}

variable "aws_region" {
  type        = string
  description = "AWS region for all resources"
  default     = "us-east-1"
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR block for the VPC"
}

variable "ha_nat" {
  type        = bool
  description = "High availability NAT (one per AZ). False = single NAT."
  default     = false
}

variable "container_insights" {
  type        = string
  description = "ECS Container Insights mode: disabled, enabled, or enhanced"
  default     = "disabled"

  validation {
    condition     = contains(["disabled", "enabled", "enhanced"], var.container_insights)
    error_message = "container_insights must be one of: disabled, enabled, enhanced."
  }
}
