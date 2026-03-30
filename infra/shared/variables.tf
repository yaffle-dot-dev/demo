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

variable "stripe_webhook_url" {
  type        = string
  description = "URL for Stripe webhook endpoint (e.g. Smee proxy for dev, public URL for prod)"
}

variable "yaffle_app_url" {
  type        = string
  description = "Public URL of the Yaffle web app (for Stripe portal return URL)"
  default     = "https://yaffle.dev"
}

variable "tailscale_runner_tags" {
  type        = list(string)
  description = "Tags allowed for ECS runner Tailscale nodes"
  default     = ["tag:ecs-runner"]
}

variable "tailscale_github_actions_tags" {
  type        = list(string)
  description = "Tags allowed for GitHub Actions ephemeral Tailscale nodes"
  default     = ["tag:ci-runner"]
}
