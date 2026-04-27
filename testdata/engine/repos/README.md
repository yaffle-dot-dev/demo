# Engine Fixture Repos

These fixture repos are the stable assertion surface for Rust engine tests.

They intentionally cover multiple scenarios instead of relying on the Yaffle
repo layout itself, which is a moving target.

Current fixtures:

- `graph-dependency-chain`
  - fake same-repo Yaffle module sources
  - static named-environment graph with shared dependencies
  - used for graph resolution tests
- `graph-env-split`
  - named-only, environment-specific, and wildcard workspaces
  - used for environment membership and transient filtering tests
- `outputs-minimal-single`
  - providerless single-workspace repo
  - used for real `tofu apply` + `tofu output -json` tests
- `outputs-remote-state-chain`
  - providerless multi-workspace repo using `terraform_remote_state`
  - used for richer output-shape and multi-workspace fixture tests

Rules:

- keep fixtures small and explicit
- prefer providerless Terraform/OpenTofu configs where possible
- add complexity only when a test scenario actually needs it
