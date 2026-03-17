# =============================================================================
# Micro Site Module Variables
# =============================================================================
# Configuration for a static micro-site behind the yaffle.dev CloudFront.
# =============================================================================

variable "site_name" {
  type        = string
  description = "Unique name for the site (e.g., 'marketing', 'docs')"
}

variable "path_pattern" {
  type        = string
  description = "CloudFront path pattern (e.g., '/docs/*' or null for default behavior)"
  default     = null
}

variable "is_default" {
  type        = bool
  description = "Whether this is the default cache behavior (path_pattern is ignored)"
  default     = false
}

variable "immutable_path_pattern" {
  type        = string
  description = "Path pattern for immutable/hashed assets (e.g., '_astro/*', '/docs/_astro/*')"
  default     = null
}

variable "primary_bucket_domain" {
  type        = string
  description = "S3 bucket regional domain name for primary origin"
}

variable "replica_bucket_domain" {
  type        = string
  description = "S3 bucket regional domain name for replica origin"
}

variable "name_suffix" {
  type        = string
  description = "Environment-specific suffix for resource naming"
}
