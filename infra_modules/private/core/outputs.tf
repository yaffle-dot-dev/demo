# =============================================================================
# Core Infrastructure Module - Outputs
# =============================================================================

# -----------------------------------------------------------------------------
# Naming
# -----------------------------------------------------------------------------

output "name_suffix" {
  value       = local.name_suffix
  description = "Name suffix for resources: <tier>-<env>-<region>"
}

# -----------------------------------------------------------------------------
# Networking
# -----------------------------------------------------------------------------

output "vpc_id" {
  value       = aws_vpc.main.id
  description = "VPC ID"
}

output "vpc_cidr_block" {
  value       = aws_vpc.main.cidr_block
  description = "VPC CIDR block"
}

output "public_subnet_ids" {
  value       = aws_subnet.public[*].id
  description = "Public subnet IDs (for ALB)"
}

output "private_subnet_ids" {
  value       = aws_subnet.private[*].id
  description = "Private subnet IDs (for ECS tasks)"
}

# -----------------------------------------------------------------------------
# ECS
# -----------------------------------------------------------------------------

output "ecs_cluster_arn" {
  value       = aws_ecs_cluster.main.arn
  description = "ECS cluster ARN"
}

output "ecs_cluster_name" {
  value       = aws_ecs_cluster.main.name
  description = "ECS cluster name"
}

output "ecs_capacity_provider_name" {
  value       = aws_ecs_capacity_provider.main.name
  description = "ECS capacity provider name"
}

output "ecs_instance_security_group_id" {
  value       = aws_security_group.ecs_instances.id
  description = "Security group ID for ECS instances"
}

# -----------------------------------------------------------------------------
# ECR
# -----------------------------------------------------------------------------

output "ecr_control_plane_url" {
  value       = aws_ecr_repository.control_plane.repository_url
  description = "ECR repository URL for control-plane images"
}

output "ecr_control_plane_arn" {
  value       = aws_ecr_repository.control_plane.arn
  description = "ECR repository ARN for control-plane images"
}

output "ecr_web_url" {
  value       = aws_ecr_repository.web.repository_url
  description = "ECR repository URL for web app images"
}

output "ecr_web_arn" {
  value       = aws_ecr_repository.web.arn
  description = "ECR repository ARN for web app images"
}

output "ecr_runner_url" {
  value       = aws_ecr_repository.runner.repository_url
  description = "ECR repository URL for runner images"
}

output "ecr_runner_arn" {
  value       = aws_ecr_repository.runner.arn
  description = "ECR repository ARN for runner images"
}

# -----------------------------------------------------------------------------
# General
# -----------------------------------------------------------------------------

output "tier" {
  value       = var.tier
  description = "Infrastructure tier (production/nonprod)"
}

output "environment" {
  value       = var.environment
  description = "Environment name"
}

output "aws_region" {
  value       = var.aws_region
  description = "AWS region"
}
