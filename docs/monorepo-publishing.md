# Repository Publishing

The Yaffle control plane, CLI, Outputs Action, and demo are independent repositories. This checkout
may place the public repositories under ignored directories for cross-repository development, but no
workflow republishes the CLI from this repository.

## Published projects

- `actions/outputs-action` is tree-synced to `yaffle-dot-dev/outputs-action`.
- `demo/` may be a nested checkout of `yaffle-dot-dev/demo`.
- `cli/` may be a nested checkout of `yaffle-dot-dev/cli`.

The CLI and demo own their source, history, CI, tags, and releases. They are ignored by the parent
repository and must be reviewed and pushed from their own repository roots.

## Outputs Action

The Outputs Action remains the only bidirectional tree-sync project. Its automation is:

- `.github/workflows/publish-outputs-action.yml`
- `.github/workflows/check-outputs-action-sync.yml`
- `.github/workflows/import-public-project.yml`
- `scripts/export-project.sh`
- `scripts/import-project.sh`
- `scripts/check-project-sync.sh`

Cross-repository publication uses a short-lived GitHub App installation token. The source repository
stores `YAFFLE_INTERNAL_GH_APP_ID` and `YAFFLE_INTERNAL_GH_APP_PRIVATE_KEY`; the installation is
scoped to the Outputs Action repository with `contents:write`.

The export rejects symlinks, environment files, Terraform state, databases, credential files, and
secret-like files. It also runs the Outputs Action typecheck/build and verifies its committed bundle
is current before publishing.

Accepted public contributions must be imported before another export so the parent cannot overwrite
public-only changes.
