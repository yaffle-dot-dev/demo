# Sandbox Infrastructure
# Deploys to: development only (uses single environment string shorthand)
# Demonstrates the environments = "development" syntax (string instead of array)

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

variable "environment" {
  type        = string
  description = "The environment name"
}

variable "sandbox_mode" {
  type        = bool
  description = "Whether sandbox mode is enabled (from yaffle.toml)"
}

locals {
  # Sandbox-specific settings
  sandbox_config = {
    auto_destroy_hours = 24
    max_resources      = 10
    allow_experiments  = true
  }
}

# Sandbox creation timestamp
resource "time_static" "sandbox_created" {}

# Sandbox expiration (auto-destroy after 24 hours for cleanup)
resource "time_offset" "sandbox_expiry" {
  offset_hours = local.sandbox_config.auto_destroy_hours
}

# Sandbox identifier
resource "random_pet" "sandbox_name" {
  length    = 3
  separator = "-"
  prefix    = "sandbox"
}

# Sandbox resource placeholder
resource "null_resource" "sandbox_environment" {
  triggers = {
    sandbox_mode   = var.sandbox_mode
    sandbox_name   = random_pet.sandbox_name.id
    created_at     = time_static.sandbox_created.rfc3339
    expires_at     = time_offset.sandbox_expiry.rfc3339
    max_resources  = local.sandbox_config.max_resources
  }
}

# Experiment tracking (sandboxes can have experiments)
resource "null_resource" "experiment_tracker" {
  count = local.sandbox_config.allow_experiments ? 1 : 0

  triggers = {
    experiments_enabled = "true"
    sandbox_name        = random_pet.sandbox_name.id
  }
}

# Random shuffle for experiment variants
resource "random_shuffle" "experiment_variants" {
  input        = ["control", "variant_a", "variant_b", "variant_c"]
  result_count = 2
}

output "sandbox_name" {
  value       = random_pet.sandbox_name.id
  description = "Friendly sandbox name"
}

output "sandbox_mode" {
  value       = var.sandbox_mode
  description = "Sandbox mode status"
}

output "created_at" {
  value       = time_static.sandbox_created.rfc3339
  description = "Sandbox creation timestamp"
}

output "expires_at" {
  value       = time_offset.sandbox_expiry.rfc3339
  description = "Sandbox expiration timestamp"
}

output "selected_variants" {
  value       = random_shuffle.experiment_variants.result
  description = "Randomly selected experiment variants"
}

output "sandbox_config" {
  value       = local.sandbox_config
  description = "Sandbox configuration"
}
