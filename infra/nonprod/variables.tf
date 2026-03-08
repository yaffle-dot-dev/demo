variable "aws_region" {
  type        = string
  description = "AWS region for all resources"
  default     = "us-east-1"
}

variable "environment" {
  type        = string
  description = "Environment name (e.g. 'nonprod')"
  default     = "nonprod"
}

variable "instance_types" {
  type        = list(string)
  description = "EC2 instance types for ECS cluster (multiple for spot diversity)"
  default     = ["t3.small", "t3.medium", "t3a.small", "t3a.medium"]
}

variable "min_instances" {
  type        = number
  description = "Minimum number of EC2 instances in the cluster"
  default     = 0
}

variable "max_instances" {
  type        = number
  description = "Maximum number of EC2 instances in the cluster"
  default     = 5
}
