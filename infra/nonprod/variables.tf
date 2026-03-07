variable "aws_region" {
  type        = string
  description = "AWS region for all resources"
  default     = "us-east-1"
}

variable "instance_types" {
  type        = list(string)
  description = "EC2 instance types for ECS cluster (multiple for spot diversity)"
  default     = ["t3.small", "t3.medium", "t3a.small", "t3a.medium"]
}

variable "min_instances" {
  type        = number
  description = "Minimum number of EC2 instances in the cluster"
  default     = 0 # Scale to zero when no previews
}

variable "max_instances" {
  type        = number
  description = "Maximum number of EC2 instances in the cluster"
  default     = 5
}

locals {
  name_prefix = "yaffle-nonprod"
  environment = "nonprod"

  # VPC CIDR - nonprod uses 10.1.x.x (different from prod 10.0.x.x)
  vpc_cidr = "10.1.0.0/16"
}
