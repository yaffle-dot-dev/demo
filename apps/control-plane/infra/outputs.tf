# =============================================================================
# Outputs
# =============================================================================
# Control plane application outputs.
# Core infrastructure outputs (VPC, ECS cluster, state storage) are in infra/.
# =============================================================================

# -----------------------------------------------------------------------------
# Environment
# -----------------------------------------------------------------------------

output "environment" {
  value       = var.environment
  description = "The environment this infrastructure belongs to"
}

# -----------------------------------------------------------------------------
# ECS Service
# -----------------------------------------------------------------------------

output "control_plane_service_name" {
  value       = aws_ecs_service.control_plane.name
  description = "Control plane ECS service name"
}

output "control_plane_task_definition_arn" {
  value       = aws_ecs_task_definition.control_plane.arn
  description = "Control plane task definition ARN"
}

output "control_plane_task_role_arn" {
  value       = aws_iam_role.control_plane_task.arn
  description = "Control plane task IAM role ARN"
}

# tf_runner_task_role_arn moved to apps/runner/infra outputs

# -----------------------------------------------------------------------------
# Load Balancer
# -----------------------------------------------------------------------------

output "alb_dns_name" {
  value       = aws_lb.main.dns_name
  description = "ALB DNS name"
}

output "api_url" {
  value       = "https://${local.api_domain}"
  description = "Control plane API URL"
}

output "api_domain" {
  value       = local.api_domain
  description = "Control plane API domain name"
}

output "alb_arn" {
  value       = aws_lb.main.arn
  description = "ALB ARN (shared by control plane and web app)"
}

output "https_listener_arn" {
  value       = aws_lb_listener.https.arn
  description = "HTTPS listener ARN for adding target group rules"
}

output "alb_security_group_id" {
  value       = aws_security_group.alb.id
  description = "ALB security group ID (for web app ingress rules)"
}

output "vpc_id" {
  value       = local.vpc_id
  description = "VPC ID for the environment"
}

output "private_subnet_ids" {
  value       = local.private_subnet_ids
  description = "Private subnet IDs for ECS tasks"
}

output "ecs_cluster_arn" {
  value       = local.ecs_cluster_arn
  description = "ECS cluster ARN"
}

output "ecs_cluster_name" {
  value       = local.ecs_cluster_name
  description = "ECS cluster name"
}

# -----------------------------------------------------------------------------
# State Storage
# -----------------------------------------------------------------------------

output "state_bucket_name" {
  value       = module.bootstrap.bucket_name
  description = "S3 bucket for this environment's terraform state"
}

output "state_bucket_arn" {
  value       = module.bootstrap.bucket_arn
  description = "S3 bucket ARN"
}
