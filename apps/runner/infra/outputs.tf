# =============================================================================
# Outputs
# =============================================================================
# Runner infrastructure outputs for use by the control plane.
# =============================================================================

# -----------------------------------------------------------------------------
# Task Definition
# -----------------------------------------------------------------------------

output "task_definition_arn" {
  value       = aws_ecs_task_definition.runner.arn
  description = "Runner ECS task definition ARN"
}

output "task_definition_family" {
  value       = aws_ecs_task_definition.runner.family
  description = "Runner ECS task definition family"
}

output "task_definition_revision" {
  value       = aws_ecs_task_definition.runner.revision
  description = "Runner ECS task definition revision"
}

# -----------------------------------------------------------------------------
# IAM
# -----------------------------------------------------------------------------

output "execution_role_arn" {
  value       = aws_iam_role.runner_execution.arn
  description = "Runner ECS execution role ARN"
}

output "task_role_arn" {
  value       = aws_iam_role.runner_task.arn
  description = "Runner task IAM role ARN"
}

# -----------------------------------------------------------------------------
# Networking
# -----------------------------------------------------------------------------

output "security_group_id" {
  value       = aws_security_group.runner.id
  description = "Runner security group ID"
}

output "subnet_ids" {
  value       = local.private_subnet_ids
  description = "Subnet IDs where runner tasks can be launched"
}

# -----------------------------------------------------------------------------
# ECS Cluster (from core)
# -----------------------------------------------------------------------------

output "ecs_cluster_arn" {
  value       = local.ecs_cluster_arn
  description = "ECS cluster ARN for launching runner tasks"
}

output "ecs_cluster_name" {
  value       = local.ecs_cluster_name
  description = "ECS cluster name"
}

# -----------------------------------------------------------------------------
# CloudWatch
# -----------------------------------------------------------------------------

output "log_group_name" {
  value       = aws_cloudwatch_log_group.runner.name
  description = "CloudWatch log group name for runner logs"
}

output "log_group_arn" {
  value       = aws_cloudwatch_log_group.runner.arn
  description = "CloudWatch log group ARN for runner logs"
}

# -----------------------------------------------------------------------------
# Scanner Lambda
# -----------------------------------------------------------------------------

output "scanner_lambda_function_name" {
  value       = aws_lambda_function.scanner.function_name
  description = "Scanner Lambda function name"
}

output "scanner_lambda_arn" {
  value       = aws_lambda_function.scanner.arn
  description = "Scanner Lambda function ARN"
}

