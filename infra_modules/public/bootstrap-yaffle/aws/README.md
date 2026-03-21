# bootstrap-yaffle/aws

Creates an AWS IAM role that Yaffle can assume for Terraform execution.

Default behavior attaches `AdministratorAccess`, which matches common Terraform runner setups.
You can pass `managed_policy_arns` to customize permissions.

## Usage

```hcl
module "yaffle_bootstrap" {
  source = "git::https://github.com/yaffle-dot-dev/yaffle.git//infra_modules/public/bootstrap-yaffle/aws?ref=main"

  yaffle_principal_arn = "arn:aws:iam::123456789012:role/yaffle-org-broker-..."
  external_id          = "yaffle-your-org-main-abc123"
  role_name            = "yaffle-assume-role-main-use1"
  environment          = "main"
}
```

## Inputs

- `yaffle_principal_arn`: IAM role ARN for your org broker principal
- `external_id`: ExternalId required for `sts:AssumeRole`
- `role_name`: Customer account IAM role name to create
- `environment`: Tag value
- `managed_policy_arns`: Managed policies to attach (defaults to `AdministratorAccess`)
- `tags`: Additional tags

## Outputs

- `role_arn`
- `role_name`
- `external_id`
