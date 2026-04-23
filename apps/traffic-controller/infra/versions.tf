terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.40"
    }
  }

  # Backend is injected by Yaffle via backend_override.tf
  # Do not add a backend block here - Yaffle manages state storage
}

locals {
  traffic_controller_resource_classes = {
    default  = "traffic-controller"
    compute  = "traffic-controller-compute"
    queue    = "traffic-controller-queue"
    schedule = "traffic-controller-schedule"
    logs     = "traffic-controller-logs"
    secrets  = "traffic-controller-secrets"
    iam      = "traffic-controller-iam"
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      project                 = "yaffle"
      layer                   = "app"
      app                     = "traffic-controller"
      environment             = var.environment
      managed_by              = "yaffle"
      "yaffle:resource-class" = local.traffic_controller_resource_classes.default
    }
  }
}
