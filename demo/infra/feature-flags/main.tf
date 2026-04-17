# Feature Flags Infrastructure
# Deploys to: ALL environments (including transient PR environments)
# Uses environments = ["*"] which matches everything

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

variable "environment" {
  type        = string
  description = "The environment name (production, staging, pr-123, etc.)"
}

locals {
  # Determine if this is a PR/transient environment
  is_pr_environment = can(regex("^pr-[0-9]+$", var.environment))

  # Feature flags with environment-specific defaults
  default_flags = {
    new_dashboard = {
      enabled     = local.is_pr_environment ? true : false
      description = "New dashboard UI"
    }
    beta_api = {
      enabled     = var.environment == "staging" || local.is_pr_environment
      description = "Beta API endpoints"
    }
    dark_mode = {
      enabled     = true
      description = "Dark mode support"
    }
    analytics_v2 = {
      enabled     = var.environment == "production"
      description = "New analytics engine"
    }
  }
}

# Feature flag configuration store
resource "null_resource" "feature_flag_store" {
  triggers = {
    environment       = var.environment
    is_pr_environment = local.is_pr_environment
    flags_hash        = sha256(jsonencode(local.default_flags))
  }
}

# Individual feature flag resources
resource "null_resource" "flag_new_dashboard" {
  triggers = {
    name        = "new_dashboard"
    enabled     = local.default_flags.new_dashboard.enabled
    environment = var.environment
  }
}

resource "null_resource" "flag_beta_api" {
  triggers = {
    name        = "beta_api"
    enabled     = local.default_flags.beta_api.enabled
    environment = var.environment
  }
}

resource "null_resource" "flag_dark_mode" {
  triggers = {
    name        = "dark_mode"
    enabled     = local.default_flags.dark_mode.enabled
    environment = var.environment
  }
}

resource "null_resource" "flag_analytics_v2" {
  triggers = {
    name        = "analytics_v2"
    enabled     = local.default_flags.analytics_v2.enabled
    environment = var.environment
  }
}

# Generate flag evaluation key
resource "random_id" "evaluation_key" {
  byte_length = 16
  prefix      = "${var.environment}-flags-"
}

output "environment" {
  value       = var.environment
  description = "Current environment"
}

output "is_pr_environment" {
  value       = local.is_pr_environment
  description = "Whether this is a PR/transient environment"
}

output "feature_flags" {
  value       = local.default_flags
  description = "Feature flag configuration"
}

output "evaluation_key" {
  value       = random_id.evaluation_key.hex
  description = "Key for flag evaluation requests"
}
