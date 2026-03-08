# Main branch environment configuration
environment = "main"
aws_region  = "us-east-1"
domain      = "yaffle.dev"

# Container image - updated by CI on deploy
control_plane_image = "ghcr.io/yaffle-dot-dev/yaffle/control-plane:latest"

# Secrets Manager ARN prefix
# Secrets should be created manually or via a separate bootstrap process:
#   - yaffle/main/database-url
#   - yaffle/main/github-app-id
#   - yaffle/main/github-app-private-key
#   - yaffle/main/github-webhook-secret
#   - yaffle/main/better-auth-secret
secrets_arn_prefix = "arn:aws:secretsmanager:us-east-1:ACCOUNT_ID:secret:yaffle/main"
