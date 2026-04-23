output "environment" {
  value       = var.environment
  description = "The environment this infrastructure belongs to"
}

output "api_lambda_function_name" {
  value       = aws_lambda_function.api.function_name
  description = "Traffic-controller command Lambda function name"
}

output "api_lambda_arn" {
  value       = aws_lambda_function.api.arn
  description = "Traffic-controller command Lambda ARN"
}

output "reconcile_lambda_function_name" {
  value       = aws_lambda_function.reconcile.function_name
  description = "Traffic-controller reconcile Lambda function name"
}

output "reconcile_lambda_arn" {
  value       = aws_lambda_function.reconcile.arn
  description = "Traffic-controller reconcile Lambda ARN"
}

output "reconcile_queue_url" {
  value       = aws_sqs_queue.reconcile.id
  description = "SQS queue URL for reconciliation jobs"
}

output "reconcile_queue_arn" {
  value       = aws_sqs_queue.reconcile.arn
  description = "SQS queue ARN for reconciliation jobs"
}

output "reconcile_dlq_arn" {
  value       = aws_sqs_queue.reconcile_dlq.arn
  description = "Dead-letter queue ARN for reconciliation jobs"
}

output "app_deployer_role_arn" {
  value       = module.shared.app_deployer_role_arn
  description = "IAM role ARN for human app deployers"
}
