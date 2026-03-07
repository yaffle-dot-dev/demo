variable "aws_region" {
  type        = string
  description = "AWS region for all resources"
  default     = "us-east-1"
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

locals {
  name_prefix = "yaffle-prod"
  environment = "production"

  # VPC CIDR - production uses 10.0.x.x
  vpc_cidr = "10.0.0.0/16"
}
