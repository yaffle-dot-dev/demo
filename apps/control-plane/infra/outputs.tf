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

output "tf_runner_task_role_arn" {
  value       = aws_iam_role.tf_runner_task.arn
  description = "TF runner task IAM role ARN"
}

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

# -----------------------------------------------------------------------------
# State Storage
# -----------------------------------------------------------------------------

output "state_bucket_name" {
  value       = aws_s3_bucket.state.id
  description = "S3 bucket for this environment's terraform state"
}

output "state_bucket_arn" {
  value       = aws_s3_bucket.state.arn
  description = "S3 bucket ARN"
}
