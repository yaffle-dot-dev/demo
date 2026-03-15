# Shared Infrastructure
# Deploys to ALL environments (including transient PR environments)
# This workspace demonstrates basic null_resource and random provider usage.

terraform {
  required_version = ">= 1.0"

  required_providers {
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

# Environment name is passed in by Yaffle
variable "environment" {
  type        = string
  description = "The environment name (e.g., production, staging, pr-123)"
}

# Generate a unique identifier for this environment
resource "random_id" "environment_id" {
  byte_length = 8
  prefix      = "${var.environment}-"
}

# Shared configuration that exists in all environments
resource "null_resource" "shared_config" {
  triggers = {
    environment    = var.environment
    environment_id = random_id.environment_id.hex
  }
}

# Random string for demonstration
resource "random_string" "suffix" {
  length  = 8
  special = false
  upper   = false
}

output "environment_id" {
  value       = random_id.environment_id.hex
  description = "Unique identifier for this environment"
}

output "shared_suffix" {
  value       = random_string.suffix.result
  description = "Random suffix for shared resources"
}
