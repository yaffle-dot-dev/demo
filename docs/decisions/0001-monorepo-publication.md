# ADR 0001: publish standalone repos from the monorepo

## Status

Accepted

## Context

We want `actions/outputs-action`, `packages/cli`, and `demo` to exist as independent GitHub repos without extracting them from the monorepo.

Target repos:

- `yaffle-dot-dev/outputs-action`
- `yaffle-dot-dev/cli`
- `yaffle-dot-dev/demo`

Requirements:

- the monorepo stays canonical
- Yaffle team works primarily in the monorepo
- public repos may accept community contributions
- useful history should be preserved
- GitHub Actions workflow symlinks are off the table
- the result should stay understandable for maintainers

## Decision

Use a mixed model:

- `actions/outputs-action` uses file-tree sync between the monorepo path and the public repo
- `demo` and `packages/cli` still use subtree-based export for now

Cross-repo publication authenticates with a short-lived GitHub App installation token derived at workflow runtime via `actions/create-github-app-token` instead of a long-lived PAT.

Shared CI logic is implemented with:

- a reusable workflow: `.github/workflows/publish-project.yml`
- thin per-project wrappers for path-based triggers
- a shared shell script: `scripts/publish-project.sh`

The standalone CLI repo also gets its own generated packaging files (`flake.nix`, `flake.lock`, `nix/yaffle-cli.nix`) and a release workflow for GitHub-hosted binary builds.

`outputs-action` keeps its standalone repo files directly inside its source path in the monorepo so public PRs can sync back cleanly as file-tree updates.

`demo` also keeps its standalone repo files under `demo/`, but it remains a one-way published example repo.

All standalone repos publish a rolling `edge` build after CI succeeds on `main`.

For the CLI, do not create a third public `@yaffle/client` repo right now. Instead, vendor `packages/yaffle-client/src/*` into the standalone CLI publish tree.

For now, only `outputs-action` uses the bidirectional model, and it does so with tree-sync commits instead of shared git ancestry. `demo` remains one-way, and `cli` remains monorepo-first until its standalone repo shape stops depending on publish-time materialization.

## Why this over full extraction

- it keeps developer workflow in the monorepo intact
- it preserves subtree history for each published project
- it keeps bidirectional sync limited to projects whose repo shape maps cleanly back into the monorepo
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

- `outputs-action` exports by cloning the public repo, syncing the monorepo tree into it, and pushing a normal sync commit on top of public `main`
- accepted public `outputs-action` changes are imported back into the monorepo as bot-authored tree-sync commits on a stable import branch
- standalone repo CI for `outputs-action` lives inside the project path in the monorepo
- monorepo PRs that touch `outputs-action` are guarded by a sync-check workflow so unimported public changes block merge before export can overwrite them
- standalone CLI packaging and release workflows are also generated from monorepo templates
- standalone repos publish a rolling `edge` channel after CI passes on `main`
- cross-repo publish credentials come from the Yaffle GitHub App secrets rather than per-repo PATs
- CLI standalone history is subtree history plus a generated publish tip commit
- standalone releases remain a separate concern from branch publishing
