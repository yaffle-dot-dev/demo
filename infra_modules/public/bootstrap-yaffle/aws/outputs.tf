output "role_arn" {
  description = "ARN of the bootstrap IAM role"
  value       = aws_iam_role.yaffle_role.arn
}

output "role_name" {
  description = "Name of the bootstrap IAM role"
  value       = aws_iam_role.yaffle_role.name
}

output "external_id" {
  description = "External ID configured in the trust policy"
  value       = var.external_id
}
