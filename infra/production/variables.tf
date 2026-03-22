variable "aws_region" {
  type        = string
  description = "AWS region for all resources"
  default     = "us-east-1"
}

variable "environment" {
  type        = string
  description = "Environment name (branch name, e.g. 'main')"
}

variable "environment_kind" {
  type        = string
  description = "Environment kind (passed by Yaffle, unused in production)"
  default     = "production"
}

variable "instance_type" {
  type        = string
  description = "EC2 instance type for ECS cluster"
  default     = "t3.medium"
}

variable "min_instances" {
  type        = number
  description = "Minimum number of EC2 instances in the cluster"
  default     = 2
}

variable "max_instances" {
  type        = number
  description = "Maximum number of EC2 instances in the cluster"
  default     = 10
}
