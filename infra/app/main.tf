terraform {
  required_version = ">= 1.8"
}

variable "environment" {
  type = string
}

variable "min_instances" {
  type = number
}

variable "max_instances" {
  type = number
}

variable "enable_debug" {
  type = bool
}

module "shared_network" {
  source = "yaffle.dev/yaffle-dot-dev--yaffle-demo/infra--shared/yaffle"
}

resource "terraform_data" "application" {
  input = {
    environment        = var.environment
    network_id         = module.shared_network.network_id
    private_subnet_ids = module.shared_network.private_subnet_ids
    min_instances      = var.min_instances
    max_instances      = var.max_instances
    debug              = var.enable_debug
  }
}

output "deployment" {
  value = terraform_data.application.output
}
