# Yaffle Local-Only Orchestration Demo

This repository exercises Yaffle plans, approvals, applies, outputs, and teardown
without provisioning cloud infrastructure. It contains no AWS or Cloudflare
resources and needs no cloud-provider credentials.

The six OpenTofu workspaces use only `terraform_data` and the `null`, `random`,
`time`, and `local` providers:

| Workspace                 | Purpose                                                   | Side effects                             |
| ------------------------- | --------------------------------------------------------- | ---------------------------------------- |
| `infra/core`              | Project settings, monitoring flags, and rotation metadata | State only                               |
| `infra/database`          | Simulated database instances and backup settings          | State only                               |
| `infra/app`               | Simulated network and application configuration           | State only                               |
| `infra/feature-flags`     | Environment-specific feature flags                        | State only                               |
| `infra/sandbox`           | Sandbox metadata and experiment variants                  | State only                               |
| `infra/preview-isolation` | Automatic preview naming                                  | A file in the runner's working directory |

Names such as database, network, and monitoring represent fixtures, not deployed
services. Hosted execution still uses Yaffle's runner and state-storage services;
the demo itself does not create cloud resources.

## Automatic OpenTofu preview isolation

The `infra/preview-isolation` workspace configures one stable filename:

```toml
variables.resource_name = "yaffle-product-demo"
```

Yaffle materializes an isolated name for a pull request without rewriting the
repository source.

| Event                          | Environment   | Materialized filename                 |
| ------------------------------ | ------------- | ------------------------------------- |
| Pull request opened or updated | `pr-{number}` | `yaffle-product-demo-{stable-suffix}` |
| Pull request closed            | `pr-{number}` | Preview file destroyed                |
| Push to `main`                 | `production`  | `yaffle-product-demo`                 |

The pinned `hashicorp/local` `2.5.3` provider exercises provider resolution,
immutable source transformation, plan, apply, outputs, and destroy without a
cloud account.

## Run the demo

Install the Yaffle GitHub App for this repository and connect it to your Yaffle
organization. No AWS or Cloudflare connection is required.

1. Create a branch and change `variables.demo_message` in `yaffle.toml`.
2. Open a pull request.
3. Watch Yaffle plan the selected workspaces under one `pr-{number}` environment.
4. Approve any required gates and deploy the preview.
5. Inspect the workspace outputs, including the materialized filename.
6. Close the pull request and watch Yaffle tear down the preview fixtures.

Production changes to the core and database fixtures retain their approval gate.
Named-environment selection and push triggers are defined in `yaffle.toml`.

## Previously deployed resources

Removing the former cloud workspace from source does not prove its existing
resources were destroyed. Any previously deployed Worker, KV namespace, or
Alchemy state-store resources require a separate, explicitly authorized cleanup.

## Validate locally

```bash
tofu -chdir=infra/preview-isolation fmt -check
tofu -chdir=infra/preview-isolation init -backend=false -lockfile=readonly
tofu -chdir=infra/preview-isolation validate
```
