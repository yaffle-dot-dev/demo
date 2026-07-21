export interface ProviderCredentialSignatureSeed {
  providerType: string
  displayName: string
  suggestedCredentialProviderType: "envvar" | "iam_role"
  exactEnvVars: string[]
  prefixEnvVars: string[]
}

export const DEFAULT_PROVIDER_CREDENTIAL_SIGNATURES: ProviderCredentialSignatureSeed[] = [
  {
    providerType: "aws",
    displayName: "AWS",
    suggestedCredentialProviderType: "iam_role",
    exactEnvVars: [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_PROFILE",
      "AWS_REGION",
      "AWS_DEFAULT_REGION",
    ],
    prefixEnvVars: [],
  },
  {
    providerType: "cloudflare",
    displayName: "Cloudflare",
    suggestedCredentialProviderType: "envvar",
    exactEnvVars: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL"],
    prefixEnvVars: [],
  },
  {
    providerType: "hookdeck",
    displayName: "Hookdeck",
    suggestedCredentialProviderType: "envvar",
    exactEnvVars: ["HOOKDECK_API_KEY", "HOOKDECK_API_BASE"],
    prefixEnvVars: [],
  },
  {
    providerType: "tailscale",
    displayName: "Tailscale",
    suggestedCredentialProviderType: "envvar",
    exactEnvVars: [
      "TAILSCALE_OAUTH_CLIENT_ID",
      "TAILSCALE_OAUTH_CLIENT_SECRET",
      "TAILSCALE_API_KEY",
    ],
    prefixEnvVars: ["TAILSCALE_"],
  },
  {
    providerType: "grafana",
    displayName: "Grafana",
    suggestedCredentialProviderType: "envvar",
    exactEnvVars: [
      "GRAFANA_AUTH",
      "GRAFANA_URL",
      "GRAFANA_CLOUD_ACCESS_POLICY_TOKEN",
      "GRAFANA_CLOUD_API_KEY",
    ],
    prefixEnvVars: ["GRAFANA_"],
  },
  {
    providerType: "databricks",
    displayName: "Databricks",
    suggestedCredentialProviderType: "envvar",
    exactEnvVars: [
      "DATABRICKS_HOST",
      "DATABRICKS_TOKEN",
      "DATABRICKS_CLIENT_ID",
      "DATABRICKS_CLIENT_SECRET",
      "DATABRICKS_ACCOUNT_ID",
    ],
    prefixEnvVars: ["DATABRICKS_"],
  },
  {
    providerType: "github",
    displayName: "GitHub",
    suggestedCredentialProviderType: "envvar",
    exactEnvVars: [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "GITHUB_APP_ID",
      "GITHUB_APP_INSTALLATION_ID",
      "GITHUB_APP_PRIVATE_KEY",
    ],
    prefixEnvVars: ["GITHUB_", "GH_"],
  },
  {
    providerType: "newrelic",
    displayName: "New Relic",
    suggestedCredentialProviderType: "envvar",
    exactEnvVars: [
      "NEW_RELIC_API_KEY",
      "NEW_RELIC_ACCOUNT_ID",
      "NEW_RELIC_REGION",
      "NEW_RELIC_LICENSE_KEY",
      "NEW_RELIC_INSIGHTS_KEY",
    ],
    prefixEnvVars: ["NEW_RELIC_"],
  },
]
