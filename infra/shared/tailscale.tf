# =============================================================================
# Tailscale - Shared Runner Credentials
# =============================================================================

data "tailscale_acl" "current" {}

locals {
  tailscale_current_policy     = try(jsondecode(data.tailscale_acl.current.json), {})
  tailscale_current_tag_owners = try(local.tailscale_current_policy.tagOwners, {})
  tailscale_runner_tag_owners = {
    for tag in var.tailscale_runner_tags : tag => ["autogroup:admin"]
  }
  tailscale_github_actions_tag_owners = {
    for tag in var.tailscale_github_actions_tags : tag => ["autogroup:admin"]
  }
  tailscale_merged_policy = merge(local.tailscale_current_policy, {
    tagOwners = merge(
      local.tailscale_current_tag_owners,
      local.tailscale_runner_tag_owners,
      local.tailscale_github_actions_tag_owners,
    )
  })
}

resource "tailscale_acl" "policy" {
  acl                        = jsonencode(local.tailscale_merged_policy)
  overwrite_existing_content = true
}

resource "tailscale_oauth_client" "ecs_runner" {
  depends_on = [tailscale_acl.policy]

  description = "yaffle ecs runner"
  scopes      = ["auth_keys"]
  tags        = var.tailscale_runner_tags
}

resource "tailscale_oauth_client" "github_actions" {
  depends_on = [tailscale_acl.policy]

  description = "yaffle github actions"
  scopes      = ["auth_keys"]
  tags        = var.tailscale_github_actions_tags
}

resource "aws_secretsmanager_secret" "tailscale_runner_authkey" {
  name        = "yaffle/shared/tailscale/runner-authkey"
  description = "Tailscale OAuth client secret for ECS runner sidecar auth"

  tags = {
    Name      = "yaffle-shared-tailscale-runner-authkey"
    ManagedBy = "terraform"
  }
}

resource "aws_secretsmanager_secret_version" "tailscale_runner_authkey" {
  secret_id = aws_secretsmanager_secret.tailscale_runner_authkey.id

  secret_string = jsonencode({
    authkey   = tailscale_oauth_client.ecs_runner.key
    client_id = tailscale_oauth_client.ecs_runner.id
  })

  # Tailscale doesn't return the client secret on read (only at creation time),
  # so imported oauth clients have key=null in state. Ignore changes to prevent
  # overwriting manually-set secrets with null.
  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret" "tailscale_github_actions_oauth" {
  name        = "yaffle/shared/tailscale/github-actions-oauth"
  description = "Tailscale OAuth client secret for GitHub Actions ephemeral CI nodes"

  tags = {
    Name      = "yaffle-shared-tailscale-github-actions-oauth"
    ManagedBy = "terraform"
  }
}

resource "aws_secretsmanager_secret_version" "tailscale_github_actions_oauth" {
  secret_id = aws_secretsmanager_secret.tailscale_github_actions_oauth.id

  secret_string = jsonencode({
    oauth_client_id = tailscale_oauth_client.github_actions.id
    oauth_secret    = tailscale_oauth_client.github_actions.key
  })
}
