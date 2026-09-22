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

resource "terraform_data" "network" {
  input = {
    network_id = "network-${var.environment}"
    subnets = [
      "subnet-a-${var.environment}",
      "subnet-b-${var.environment}",
    ]
  }
}

resource "terraform_data" "application" {
  input = {
    environment        = var.environment
    network_id         = terraform_data.network.output.network_id
    private_subnet_ids = terraform_data.network.output.subnets
    min_instances      = var.min_instances
    max_instances      = var.max_instances
    debug              = var.enable_debug
  }
}

output "deployment" {
  value = terraform_data.application.output
}
