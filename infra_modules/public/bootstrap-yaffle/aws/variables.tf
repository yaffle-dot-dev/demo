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

variable "permissions_boundary_arn" {
  type        = string
  description = "Optional permissions boundary ARN to apply to the role"
  default     = null
  nullable    = true

  validation {
    condition = (
      var.permissions_boundary_arn == null
      || can(regex("^arn:aws(-[a-z]+)?:iam::[0-9]{12}:policy/.+$", var.permissions_boundary_arn))
    )
    error_message = "permissions_boundary_arn must be null or a valid IAM policy ARN."
  }
}

variable "allowed_session_tag_keys" {
  type        = list(string)
  description = "Session tag keys the trusted principal may pass when assuming this role"
  default     = ["environment"]
}

variable "required_session_tag_keys" {
  type        = list(string)
  description = "Session tag keys that must be present when assuming this role"
  default     = []

  validation {
    condition     = length(setsubtract(toset(var.required_session_tag_keys), toset(var.allowed_session_tag_keys))) == 0
    error_message = "required_session_tag_keys must be a subset of allowed_session_tag_keys."
  }
}

variable "required_session_tag_equals" {
  type        = map(string)
  description = "Session tag key/value pairs that must match exactly when assuming this role"
  default     = {}

  validation {
    condition     = length(setsubtract(toset(keys(var.required_session_tag_equals)), toset(var.allowed_session_tag_keys))) == 0
    error_message = "required_session_tag_equals keys must be included in allowed_session_tag_keys."
  }
}

variable "required_session_tag_not_equals" {
  type        = map(string)
  description = "Session tag key/value pairs that must not match when assuming this role"
  default     = {}

  validation {
    condition     = length(setsubtract(toset(keys(var.required_session_tag_not_equals)), toset(var.allowed_session_tag_keys))) == 0
    error_message = "required_session_tag_not_equals keys must be included in allowed_session_tag_keys."
  }
}

variable "tags" {
  type        = map(string)
  description = "Additional tags to apply"
  default     = {}
}
