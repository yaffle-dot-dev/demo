variable "environment" {
  type        = string
  description = "Environment name (branch name, e.g. 'main', or transient environment like 'pr-42')"
}

variable "aws_region" {
  type        = string
  description = "AWS region (e.g. 'us-east-1')"
}
