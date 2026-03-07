variable "environment" {
  type        = string
  description = "Environment name (e.g., 'production', 'preview-pr-42')"
}

variable "aws_region" {
  type        = string
  description = "AWS region for all resources"
  default     = "us-east-1"
}

variable "domain" {
  type        = string
  description = "Base domain for the application (e.g., 'yaffle.dev')"
  default     = "yaffle.dev"
}

variable "control_plane_image" {
  type        = string
  description = "Docker image for the control plane container"
  default     = "ghcr.io/yaffle-dot-dev/yaffle/control-plane:latest"
}

variable "secrets_arn_prefix" {
  type        = string
  description = "ARN prefix for Secrets Manager secrets (e.g., 'arn:aws:secretsmanager:us-east-1:123456789:secret:yaffle')"
}

locals {
  # Normalize environment for resource naming
  # Production uses clean names, previews get prefixed
  is_production = var.environment == "production"
  
  # Resource naming: production gets clean names, previews get environment prefix
  name_prefix = local.is_production ? "yaffle" : "yaffle-${var.environment}"

  # API domain
  api_domain = local.is_production ? "api.${var.domain}" : "${var.environment}.api.${var.domain}"
}
