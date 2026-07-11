variable "environment" {
  type        = string
  description = "Environment name - branch name (e.g., 'main') or preview (e.g., 'pr-42')"
}

variable "environment_kind" {
  type        = string
  description = "Kind of environment ('named' or 'transient')"
  default     = "named"
}

variable "aws_region" {
  type        = string
  description = "AWS region for primary resources"
  default     = "us-east-1"
}

variable "replica_region" {
  type        = string
  description = "AWS region for S3 bucket replication"
  default     = "us-west-2"
}

variable "domain" {
  type        = string
  description = "Base domain for the application (e.g., 'yaffle.dev')"
  default     = "yaffle.dev"
}

variable "module_registry_host" {
  type        = string
  description = "Hostname for the Yaffle Terraform module registry"
  default     = "yaffle.dev"
}

variable "web_image" {
  type        = string
  description = "Bootstrap Docker image for the web app container"
  default     = "870923192739.dkr.ecr.us-east-1.amazonaws.com/yaffle-web-production@sha256:f6afd16e7c192417ec19d03dc901240dae0b9004dbc37211134d7b7a445b562e"
}

module "naming" {
  source      = "../../../infra_modules/public/naming"
  environment = var.environment
  aws_region  = var.aws_region
}

module "naming_replica" {
  source      = "../../../infra_modules/public/naming"
  environment = var.environment
  aws_region  = var.replica_region
}

locals {
  # Naming: yaffle-{resource}-{suffix}
  # suffix = {environment}-{region_short} (e.g., "main-use1", "pr-42-use1")
  name_suffix                = module.naming.suffix
  replica_name_suffix        = module.naming_replica.suffix
  is_preview                 = var.environment_kind == "transient"
  site_domain                = local.is_preview ? "${var.environment}.preview.${var.domain}" : var.domain
  control_plane_api_domain   = local.is_preview ? "api-${var.environment}.preview.${var.domain}" : "api.${var.domain}"
  web_listener_rule_priority = var.environment_kind == "transient" ? 1000 + (tonumber(trimprefix(var.environment, "pr-")) % 49000) : 100
  listener_rule_host_headers = distinct([
    local.site_domain,
    "www.${local.site_domain}",
    local.control_plane_api_domain,
  ])

  # Control plane outputs (ALB, VPC, ECS cluster)
  vpc_id                = module.control_plane.vpc_id
  private_subnet_ids    = module.control_plane.private_subnet_ids
  ecs_cluster_arn       = module.control_plane.ecs_cluster_arn
  ecs_cluster_name      = module.control_plane.ecs_cluster_name
  https_listener_arn    = module.control_plane.https_listener_arn
  alb_security_group_id = module.control_plane.alb_security_group_id
}
