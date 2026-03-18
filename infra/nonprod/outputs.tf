# =============================================================================
# Non-Production Infrastructure Outputs
# =============================================================================

# -----------------------------------------------------------------------------
# Networking
# -----------------------------------------------------------------------------

output "vpc_id" {
  value       = module.core.vpc_id
  description = "VPC ID"
}

output "vpc_cidr_block" {
  value       = module.core.vpc_cidr_block
  description = "VPC CIDR block"
}

output "public_subnet_ids" {
  value       = module.core.public_subnet_ids
  description = "Public subnet IDs (for ALB)"
}

output "private_subnet_ids" {
  value       = module.core.private_subnet_ids
  description = "Private subnet IDs (for ECS tasks)"
}

# -----------------------------------------------------------------------------
# ECS
# -----------------------------------------------------------------------------

output "ecs_cluster_arn" {
  value       = module.core.ecs_cluster_arn
  description = "ECS cluster ARN"
}

output "ecs_cluster_name" {
  value       = module.core.ecs_cluster_name
  description = "ECS cluster name"
}

output "ecs_capacity_provider_name" {
  value       = module.core.ecs_capacity_provider_name
  description = "ECS capacity provider name"
}

output "ecs_instance_security_group_id" {
  value       = module.core.ecs_instance_security_group_id
  description = "Security group ID for ECS instances"
}

output "ecr_control_plane_url" {
  value       = module.core.ecr_control_plane_url
  description = "ECR repository URL for control-plane images"
}

output "ecr_control_plane_arn" {
  value       = module.core.ecr_control_plane_arn
  description = "ECR repository ARN for control-plane images"
}

output "ecr_runner_url" {
  value       = module.core.ecr_runner_url
  description = "ECR repository URL for runner images"
}

output "ecr_runner_arn" {
  value       = module.core.ecr_runner_arn
  description = "ECR repository ARN for runner images"
}

# -----------------------------------------------------------------------------
# General
# -----------------------------------------------------------------------------

output "environment" {
  value       = module.core.environment
  description = "Environment name"
}

output "aws_region" {
  value       = module.core.aws_region
  description = "AWS region"
}
