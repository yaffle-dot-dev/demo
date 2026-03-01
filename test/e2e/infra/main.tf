variable "environment" {
  type    = string
  default = "production"
}

resource "null_resource" "test" {
  triggers = {
    env = var.environment
  }
}

output "environment" {
  value       = var.environment
  description = "The deployment environment for this workspace"
}
