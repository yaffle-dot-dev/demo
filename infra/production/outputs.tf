# =============================================================================
# Production Infrastructure Outputs
# =============================================================================

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
# General
# -----------------------------------------------------------------------------

output "environment" {
  value       = local.environment
  description = "Environment name"
}

output "aws_region" {
  value       = var.aws_region
  description = "AWS region"
}
