variable "module_registry_host" {
  type    = string
  default = "yaffle.dev"
}

module "shared" {
  source = "${var.module_registry_host}/test-org--fixture/infra--shared/yaffle"
}

output "shared_message" {
  value = module.shared.message
}
