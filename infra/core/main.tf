# Core Infrastructure
# Deploys to: production, staging (named environments only)
# Demonstrates workspace variables passed from yaffle.toml

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
    time = {
      source  = "hashicorp/time"
      version = "~> 0.9"
    }
  }
}

# Variables from yaffle.toml
variable "environment" {
  type        = string
  description = "The environment name"
}

variable "project_name" {
  type        = string
  description = "Project name (from yaffle.toml variables)"
}

variable "enable_monitoring" {
  type        = bool
  description = "Whether monitoring is enabled (from yaffle.toml variables)"
}

variable "retention_days" {
  type        = number
  description = "Log retention in days (from yaffle.toml variables)"
}

# Generate a project-wide UUID
resource "random_uuid" "project_id" {}

# Core infrastructure marker
resource "null_resource" "core_infrastructure" {
  triggers = {
    project_name      = var.project_name
    environment       = var.environment
    monitoring        = var.enable_monitoring
    retention_days    = var.retention_days
    project_id        = random_uuid.project_id.result
  }
}

# Conditional resource based on monitoring flag
resource "null_resource" "monitoring_setup" {
  count = var.enable_monitoring ? 1 : 0

  triggers = {
    monitoring_enabled = "true"
    environment        = var.environment
  }
}

# Rotation timestamp for secrets/keys
resource "time_rotating" "key_rotation" {
  rotation_days = var.retention_days
}

# Random password for demonstration
resource "random_password" "admin_password" {
  length           = 24
  special          = true
  override_special = "!@#$%"
}

output "project_id" {
  value       = random_uuid.project_id.result
  description = "Unique project identifier"
}

output "monitoring_enabled" {
  value       = var.enable_monitoring
  description = "Whether monitoring is enabled"
}

output "next_rotation" {
  value       = time_rotating.key_rotation.rotation_rfc3339
  description = "Next key rotation timestamp"
}

output "admin_password_hash" {
  value       = sha256(random_password.admin_password.result)
  description = "Hash of generated admin password (not the actual password)"
  sensitive   = true
}
