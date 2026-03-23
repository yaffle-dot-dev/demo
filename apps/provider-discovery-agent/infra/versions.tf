terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  # Backend is injected by Yaffle via backend_override.tf
  # Do not add a backend block here - Yaffle manages state storage
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      project     = "yaffle"
      layer       = "app"
      app         = "provider-discovery-agent"
      environment = var.environment
      managed_by  = "yaffle"
    }
  }
}

provider "cloudflare" {
  # API token from CLOUDFLARE_API_TOKEN env var
}
