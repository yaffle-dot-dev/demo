# bootstrap-yaffle/aws

Creates an AWS IAM role that Yaffle can assume for Terraform execution.

Default behavior attaches `AdministratorAccess`, which matches common Terraform runner setups.
You can pass `managed_policy_arns` to customize permissions and
`permissions_boundary_arn` to keep a broad role constrained by policy.

Yaffle assumes AWS roles with an STS session tag named `environment`
(`production`, `staging`, `pr-42`, and so on).

For the default single-role setup, you do not need to add any tag-based
conditions. You only need the trust policy to allow both `sts:AssumeRole` and
`sts:TagSession` so Yaffle can mint session credentials successfully.

This module allows the `environment` session tag by default. If you write the
trust policy yourself, include `sts:TagSession` in the allowed actions.

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

## Advanced: cross-environment safety guardrails

If you want stronger safety boundaries between environments, make the session
tag mandatory and constrain it in the trust policy.

```hcl
module "yaffle_production" {
  source = "git::https://github.com/yaffle-dot-dev/yaffle.git//infra_modules/public/bootstrap-yaffle/aws?ref=main"

  yaffle_principal_arn     = "arn:aws:iam::123456789012:role/yaffle-org-broker-..."
  external_id              = "yaffle-your-org-production-abc123"
  role_name                = "yaffle-assume-role-production-use1"
  environment              = "production"
  required_session_tag_keys = ["environment"]
  required_session_tag_equals = {
    environment = "production"
  }
}

module "yaffle_other_environments" {
  source = "git::https://github.com/yaffle-dot-dev/yaffle.git//infra_modules/public/bootstrap-yaffle/aws?ref=main"

  yaffle_principal_arn      = "arn:aws:iam::123456789012:role/yaffle-org-broker-..."
  external_id               = "yaffle-your-org-other-envs-def456"
  role_name                 = "yaffle-assume-role-other-envs-use1"
  environment               = "shared"
  required_session_tag_keys = ["environment"]
  required_session_tag_not_equals = {
    environment = "production"
  }
}
```

You can pair the general-environments role with explicit deny guardrails or a permissions
boundary that compares `aws:ResourceTag/environment` and
`aws:RequestTag/environment` against `aws:PrincipalTag/environment`.

## Inputs

- `yaffle_principal_arn`: IAM role ARN for your org broker principal
- `external_id`: ExternalId required for `sts:AssumeRole`
- `role_name`: Customer account IAM role name to create
- `environment`: Tag value
- `managed_policy_arns`: Managed policies to attach (defaults to `AdministratorAccess`)
- `permissions_boundary_arn`: Optional permissions boundary ARN
- `allowed_session_tag_keys`: Session tag keys allowed in `AssumeRole` (defaults to `["environment"]`)
- `required_session_tag_keys`: Session tag keys that must be present
- `required_session_tag_equals`: Session tag key/value pairs that must match
- `required_session_tag_not_equals`: Session tag key/value pairs that must not match
- `tags`: Additional tags

## Outputs

- `role_arn`
- `role_name`
- `external_id`
