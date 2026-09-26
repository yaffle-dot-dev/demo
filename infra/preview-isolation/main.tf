terraform {
  required_version = ">= 1.8.0"

  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "2.5.3"
    }
  }
}

variable "resource_name" {
  description = "The stable name configured by the repository"
  type        = string
  nullable    = false
}

variable "environment" {
  description = "The Yaffle environment handling this run"
  type        = string
  nullable    = false
}

variable "demo_message" {
  description = "Change this value in a pull request to run the demo"
  type        = string
  nullable    = false
}

resource "local_file" "demo" {
  filename        = var.resource_name
  file_permission = "0644"
  content = jsonencode({
    environment = var.environment
    managed_by  = "yaffle"
    message     = var.demo_message
  })
}

output "configured_filename" {
  description = "The unchanged name supplied by yaffle.toml"
  value       = var.resource_name
}

output "materialized_filename" {
  description = "The name Yaffle materialized for this environment"
  value       = local_file.demo.filename
}

output "environment" {
  description = "The named or transient environment for this run"
  value       = var.environment
}
