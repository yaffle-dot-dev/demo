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

variable "instance_types" {
  type        = list(string)
  description = "EC2 instance types for ECS cluster"
  default     = ["t3.medium"]
}

variable "min_instances" {
  type        = number
  description = "Minimum number of EC2 instances in the cluster"
  default     = 0
}

variable "max_instances" {
  type        = number
  description = "Maximum number of EC2 instances in the cluster"
  default     = 10
}

variable "use_spot" {
  type        = bool
  description = "Use spot instances (true for nonprod, false for production)"
  default     = false
}

variable "ha_nat" {
  type        = bool
  description = "High availability NAT (one per AZ). False = single NAT."
  default     = false
}

variable "container_insights" {
  type        = bool
  description = "Enable container insights on ECS cluster"
  default     = false
}
