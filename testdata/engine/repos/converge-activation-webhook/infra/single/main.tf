terraform {
  required_version = ">= 1.8.0"
}

locals {
  service_name = "single-service"
}

output "service_name" {
  value = local.service_name
}
