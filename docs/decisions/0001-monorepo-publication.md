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
- `packages/cli` also uses file-tree sync between the monorepo path and the public repo
- `demo` still uses subtree-based export for now

Cross-repo publication authenticates with a short-lived GitHub App installation token derived at workflow runtime via `actions/create-github-app-token` instead of a long-lived PAT.

Publish automation is implemented with:

- dedicated tree-sync scripts for writable public repos: `scripts/export-project.sh`, `scripts/import-project.sh`, `scripts/check-project-sync.sh`
- thin per-project workflow wrappers for path-based triggers
- a reusable subtree-publish workflow for one-way repos: `.github/workflows/publish-project.yml`

The standalone CLI repo also gets its own checked-in packaging files (`flake.nix`, `flake.lock`, `nix/yaffle-cli.nix`) and a release workflow for GitHub-hosted binary builds.

`outputs-action` keeps its standalone repo files directly inside its source path in the monorepo so public PRs can sync back cleanly as file-tree updates.

`packages/cli` also keeps its standalone repo files directly inside its source path in the monorepo, including the local client layer it needs to stay self-contained.

`demo` also keeps its standalone repo files under `demo/`, but it remains a one-way published example repo.

All standalone repos publish a rolling `edge` build after CI succeeds on `main`.

For the CLI, do not create a third public `@yaffle/client` repo right now. Instead, keep the client layer directly under `packages/cli/src/lib/yaffle-client/` so the public CLI repo stays self-contained.

For now, `outputs-action` and `packages/cli` use the bidirectional model, and they do so with tree-sync commits instead of shared git ancestry. `demo` remains one-way.

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
- moving the client layer directly under `packages/cli` is simpler and keeps the public surface area smaller

## Consequences

- `outputs-action` exports by cloning the public repo, syncing the monorepo tree into it, and pushing a normal sync commit on top of public `main`
- `cli` exports by cloning the public repo, syncing the monorepo tree into it, and pushing a normal sync commit on top of public `main`
- accepted public `outputs-action` changes are imported back into the monorepo as bot-authored tree-sync commits on a stable import branch
- accepted public `cli` changes are imported back into the monorepo as bot-authored tree-sync commits on a stable import branch
- standalone repo CI for `outputs-action` lives inside the project path in the monorepo
- standalone repo CI for `cli` lives inside the project path in the monorepo
- monorepo PRs that touch `outputs-action` are guarded by a sync-check workflow so unimported public changes block merge before export can overwrite them
- monorepo PRs that touch `cli` are guarded by a sync-check workflow so unimported public changes block merge before export can overwrite them
- standalone CLI packaging and release workflows live inside the project path in the monorepo
- standalone repos publish a rolling `edge` channel after CI passes on `main`
- cross-repo publish credentials come from the Yaffle GitHub App secrets rather than per-repo PATs
- standalone releases remain a separate concern from branch publishing
