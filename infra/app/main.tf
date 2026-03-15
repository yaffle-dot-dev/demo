# Application Infrastructure
# Deploys to: staging, development
# Demonstrates inline table variable syntax

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

variable "min_instances" {
  type        = number
  description = "Minimum number of app instances"
}

variable "max_instances" {
  type        = number
  description = "Maximum number of app instances"
}

variable "enable_debug" {
  type        = bool
  description = "Whether debug mode is enabled"
}

# Application deployment identifier
resource "random_id" "deployment_id" {
  byte_length = 8
  prefix      = "deploy-"
}

# Simulate application instances
resource "null_resource" "app_instance" {
  count = var.min_instances

  triggers = {
    deployment_id = random_id.deployment_id.hex
    instance      = count.index
    environment   = var.environment
    debug_mode    = var.enable_debug
  }
}

# Auto-scaling configuration
resource "null_resource" "autoscaling_config" {
  triggers = {
    min_instances = var.min_instances
    max_instances = var.max_instances
    environment   = var.environment
  }
}

# Debug configuration (only in debug mode)
resource "null_resource" "debug_config" {
  count = var.enable_debug ? 1 : 0

  triggers = {
    debug_enabled = "true"
    deployment_id = random_id.deployment_id.hex
  }
}

# Generate API keys
resource "random_string" "api_key" {
  length  = 32
  special = false
}

# Random integer for port assignment (demo purposes)
resource "random_integer" "app_port" {
  min = 8000
  max = 9000
}

output "deployment_id" {
  value       = random_id.deployment_id.hex
  description = "Current deployment identifier"
}

output "api_key_preview" {
  value       = substr(random_string.api_key.result, 0, 8)
  description = "First 8 characters of API key (for verification)"
}

output "app_port" {
  value       = random_integer.app_port.result
  description = "Assigned application port"
}

output "scaling_config" {
  value = {
    min = var.min_instances
    max = var.max_instances
  }
  description = "Auto-scaling configuration"
}

output "debug_enabled" {
  value       = var.enable_debug
  description = "Debug mode status"
}
