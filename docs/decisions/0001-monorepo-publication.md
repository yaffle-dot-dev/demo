# ADR 0001: publish standalone repos from the monorepo

## Status

Accepted

## Context

We want `actions/outputs-action` and `packages/cli` to exist as independent GitHub repos without extracting them from the monorepo.

Target repos:

- `yaffle-dot-dev/outputs-action`
- `yaffle-dot-dev/cli`
- `yaffle-dot-dev/demo`

Requirements:

- the monorepo stays canonical
- publishing is one-way only
- useful history should be preserved
- GitHub Actions workflow symlinks are off the table
- the result should stay understandable for maintainers

## Decision

Use `git subtree split` from the monorepo, then materialize any standalone-only files in the split tree before force-pushing to the target repo.

Cross-repo publication authenticates with a short-lived GitHub App installation token derived at workflow runtime via `actions/create-github-app-token` instead of a long-lived PAT.

Shared CI logic is implemented with:

- a reusable workflow: `.github/workflows/publish-project.yml`
- thin per-project wrappers for path-based triggers
- a shared shell script: `scripts/publish-project.sh`

The standalone CLI repo also gets its own generated packaging files (`flake.nix`, `flake.lock`, `nix/yaffle-cli.nix`) and a release workflow for GitHub-hosted binary builds.

Both standalone repos also get generated `edge` workflows that publish a rolling build after CI succeeds on `main`.

For the CLI, do not create a third public `@yaffle/client` repo right now. Instead, vendor `packages/yaffle-client/src/*` into the standalone CLI publish tree.

## Why this over full extraction

- it keeps developer workflow in the monorepo intact
- it preserves subtree history for each published project
- it avoids bidirectional sync complexity
- it keeps review, dogfooding, and cross-project refactors in one place

## Why this over `splitsh-lite`

- `git subtree split` is already available on GitHub runners
- it is easier for maintainers to understand and debug
- it avoids adding another binary or service dependency

`splitsh-lite` would only be worth revisiting if publish runtime becomes a real bottleneck.

## Why not a third public client repo now

- the current `@yaffle/client` usage is effectively CLI-internal
- a third repo would add another compatibility and release surface
- vendoring the client into the published CLI repo is simpler and keeps the public surface area smaller

## Consequences

- target branches are publish artifacts and get force-pushed
- standalone repo CI is generated from monorepo templates
- standalone CLI packaging and release workflows are also generated from monorepo templates
- standalone repos publish a rolling `edge` channel after CI passes on `main`
- cross-repo publish credentials come from the Yaffle GitHub App secrets rather than per-repo PATs
- CLI standalone history is subtree history plus a generated publish tip commit
- standalone releases remain a separate concern from branch publishing
