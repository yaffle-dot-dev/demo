# Feature Flags Infrastructure
# Deploys to all environments, including transient pull request environments.

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
  description = "The environment name"
}

locals {
  is_pr_environment = can(regex("^pr-[0-9]+$", var.environment))

  default_flags = {
    new_dashboard = {
      enabled     = local.is_pr_environment
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

resource "null_resource" "feature_flag_store" {
  triggers = {
    environment       = var.environment
    is_pr_environment = local.is_pr_environment
    flags_hash        = sha256(jsonencode(local.default_flags))
  }
}

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

resource "random_id" "evaluation_key" {
  byte_length = 16
  prefix      = "${var.environment}-flags-"
}

# Intentional failure used to verify that Yaffle streams apply diagnostics and
# preserves the complete output after the run settles as failed.
resource "terraform_data" "runner_output_failure_probe" {
  provisioner "local-exec" {
    command = <<-EOT
      printf '\033[31mYAFFLE_FAILURE_PROBE_BEGIN\033[0m\n'
      sleep 20
      printf '\033[33mThe complete apply failure diagnostic must remain visible.\033[0m\n'
      sleep 20
      printf '\033[31mYAFFLE_FAILURE_PROBE_END_PR111\033[0m\n'
      exit 42
    EOT
  }
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
