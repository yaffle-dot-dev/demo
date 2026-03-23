resource "aws_secretsmanager_secret" "cloudflare_account_id" {
  name        = "yaffle/shared/cloudflare/account-id"
  description = "Cloudflare account ID used by CI deploy workflows"

  tags = {
    Name      = "yaffle-shared-cloudflare-account-id"
    ManagedBy = "terraform"
  }
}

resource "aws_secretsmanager_secret" "cloudflare_api_token" {
  name        = "yaffle/shared/cloudflare/api-token"
  description = "Cloudflare API token used by CI deploy workflows"

  tags = {
    Name      = "yaffle-shared-cloudflare-api-token"
    ManagedBy = "terraform"
  }
}
