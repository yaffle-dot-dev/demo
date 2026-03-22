variable "aws_region" {
  type        = string
  description = "AWS region for all resources"
  default     = "us-east-1"
}

variable "domain" {
  type        = string
  description = "Base domain for the application"
  default     = "yaffle.dev"
}

# Yaffle passes environment to all workspaces. Shared infra doesn't use it
# (it's a true singleton), but we declare it to avoid warnings.
variable "environment" {
  type        = string
  description = "Environment name (unused in shared, but passed by Yaffle)"
}

variable "environment_kind" {
  type        = string
  description = "Environment kind (unused in shared, but passed by Yaffle)"
  default     = "production"
}

variable "cloudflare_zone_id" {
  type        = string
  description = "Cloudflare zone ID for yaffle.dev (dual DNS setup)"
}

variable "tailscale_runner_tags" {
  type        = list(string)
  description = "Tags allowed for ECS runner Tailscale nodes"
  default     = ["tag:ecs-runner"]
}
