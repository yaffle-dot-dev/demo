# Yaffle Automatic Preview Isolation Demo

One Terraform workspace demonstrates the complete Yaffle product loop:

1. Open a pull request.
2. Yaffle materializes an isolated resource name for `pr-{number}`.
3. The preview plans and applies without changing repository source.
4. Merge the pull request.
5. Yaffle destroys the preview and applies the original unsuffixed name to `production`.

## The Story

The repository configures one stable filename:

```toml
variables.resource_name = "yaffle-product-demo"
```

The Terraform source uses that value directly:

```hcl
resource "local_file" "demo" {
  filename = var.resource_name
}
```

Yaffle treats the same source differently according to environment ownership:

| Event                          | Environment   | Materialized filename                 |
| ------------------------------ | ------------- | ------------------------------------- |
| Pull request opened or updated | `pr-{number}` | `yaffle-product-demo-{stable-suffix}` |
| Pull request closed            | `pr-{number}` | Preview resource destroyed            |
| Push to `main`                 | `production`  | `yaffle-product-demo`                 |

The suffix is deterministic for the organization, repository, workspace, and environment. Yaffle
adds it only inside the immutable execution artifact. It does not rewrite `main.tf`.

## Run The Product Demo

Prerequisite: install the Yaffle GitHub App for this repository and connect it to your Yaffle
organization.

1. Create a branch.
2. Change `variables.demo_message` in `yaffle.toml`.
3. Open a pull request.
4. Watch the Yaffle check create and apply the `pr-{number}` preview.
5. Inspect the `configured_filename`, `materialized_filename`, and `environment` outputs.
6. Merge the pull request.
7. Watch Yaffle destroy the preview and run the named `production` environment.

The pull-request output should show the configured name and materialized name diverging. The
production output should show both names as `yaffle-product-demo`.

## Why `local_file`?

The demo needs no cloud account, credentials, or billable infrastructure. The exact
`hashicorp/local` `2.5.3` strategy exercises provider resolution, source transformation, artifact
verification, plan, apply, outputs, and destroy.

The generated file exists only on the ephemeral runner. This is a product-mechanics demonstration,
not a recommendation to manage durable infrastructure with `local_file`.

## Validate Locally

```bash
tofu -chdir=infra/preview-isolation fmt -check
tofu -chdir=infra/preview-isolation init -backend=false -lockfile=readonly
tofu -chdir=infra/preview-isolation validate
```
