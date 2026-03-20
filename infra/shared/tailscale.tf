# =============================================================================
# Tailscale - Shared Runner Credentials
# =============================================================================
# True singleton resources for ECS runner connectivity back to local/dev control
# planes over Tailscale.
#
# These live in shared infra because they are tailnet-global trust credentials,
# similar in spirit to DNS and GitHub OIDC.
# =============================================================================

data "tailscale_acl" "current" {}

locals {
  tailscale_current_policy     = try(jsondecode(data.tailscale_acl.current.json), {})
  tailscale_current_tag_owners = try(local.tailscale_current_policy.tagOwners, {})
  tailscale_runner_tag_owners = {
    for tag in var.tailscale_runner_tags : tag => ["autogroup:admin"]
  }
  tailscale_merged_policy = merge(local.tailscale_current_policy, {
    tagOwners = merge(local.tailscale_current_tag_owners, local.tailscale_runner_tag_owners)
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
}
