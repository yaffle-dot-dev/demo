# Database Infrastructure
# Deploys to: production only
# Demonstrates number and boolean variables

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

variable "instance_count" {
  type        = number
  description = "Number of database instances (from yaffle.toml)"
}

variable "enable_backups" {
  type        = bool
  description = "Whether backups are enabled (from yaffle.toml)"
}

# Generate unique identifiers for each database instance
resource "random_id" "db_instance_id" {
  count       = var.instance_count
  byte_length = 4
  prefix      = "db-${var.environment}-"
}

# Database instance placeholders
resource "null_resource" "database_instance" {
  count = var.instance_count

  triggers = {
    instance_id    = random_id.db_instance_id[count.index].hex
    instance_index = count.index
    environment    = var.environment
    backups        = var.enable_backups
  }
}

# Backup configuration (only created if backups enabled)
resource "null_resource" "backup_configuration" {
  count = var.enable_backups ? 1 : 0

  triggers = {
    backup_enabled  = "true"
    instance_count  = var.instance_count
  }
}

# Generate database credentials
resource "random_password" "db_password" {
  count            = var.instance_count
  length           = 32
  special          = true
  override_special = "_-"
}

# Random pet names for database clusters
resource "random_pet" "cluster_name" {
  length    = 2
  separator = "-"
}

output "cluster_name" {
  value       = random_pet.cluster_name.id
  description = "Friendly name for the database cluster"
}

output "instance_ids" {
  value       = random_id.db_instance_id[*].hex
  description = "List of database instance identifiers"
}

output "instance_count" {
  value       = var.instance_count
  description = "Number of database instances"
}

output "backups_enabled" {
  value       = var.enable_backups
  description = "Whether backups are configured"
}
