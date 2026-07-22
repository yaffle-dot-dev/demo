terraform {
  required_version = ">= 1.8"
}

variable "environment" {
  type = string
}

resource "terraform_data" "network" {
  input = {
    environment = var.environment
    network_id  = "network-${var.environment}"
    subnets     = ["subnet-a-${var.environment}", "subnet-b-${var.environment}"]
  }
}

output "network_id" {
  value = terraform_data.network.output.network_id
}

output "private_subnet_ids" {
  value = terraform_data.network.output.subnets
}
