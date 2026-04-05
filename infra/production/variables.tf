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
