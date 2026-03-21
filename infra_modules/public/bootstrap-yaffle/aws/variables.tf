variable "yaffle_principal_arn" {
  type        = string
  description = "IAM role ARN that Yaffle uses as org broker principal"

  validation {
    condition     = can(regex("^arn:aws(-[a-z]+)?:iam::[0-9]{12}:role/.+$", var.yaffle_principal_arn))
    error_message = "yaffle_principal_arn must be a valid IAM role ARN."
  }
}

variable "external_id" {
  type        = string
  description = "Required ExternalId condition for sts:AssumeRole"

  validation {
    condition     = length(trimspace(var.external_id)) > 0
    error_message = "external_id must not be empty."
  }
}

variable "role_name" {
  type        = string
  description = "Name of the bootstrap role created in the customer account"

  validation {
    condition     = can(regex("^[A-Za-z0-9+=,.@_-]{1,64}$", var.role_name))
    error_message = "role_name must be a valid IAM role name (1-64 chars)."
  }
}

variable "environment" {
  type        = string
  description = "Environment label for tags"
  default     = "main"
}

variable "managed_policy_arns" {
  type        = list(string)
  description = "Managed policy ARNs to attach to the role"
  default     = ["arn:aws:iam::aws:policy/AdministratorAccess"]
}

variable "tags" {
  type        = map(string)
  description = "Additional tags to apply"
  default     = {}
}
