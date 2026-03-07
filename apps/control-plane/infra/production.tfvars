# Production environment configuration
environment = "production"
aws_region  = "us-east-1"
domain      = "yaffle.dev"

# Container image - updated by CI on deploy
control_plane_image = "ghcr.io/yaffle-dot-dev/yaffle/control-plane:latest"

# Secrets Manager ARN prefix
# Secrets should be created manually or via a separate bootstrap process:
#   - yaffle/production/database-url
#   - yaffle/production/github-app-id
#   - yaffle/production/github-app-private-key
#   - yaffle/production/github-webhook-secret
#   - yaffle/production/better-auth-secret
secrets_arn_prefix = "arn:aws:secretsmanager:us-east-1:ACCOUNT_ID:secret:yaffle/production"
