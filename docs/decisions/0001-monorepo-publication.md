# ADR 0001: publish standalone repositories

## Status

Partially superseded by YAF-252.

## Context

Yaffle maintains public projects alongside the hosted control plane. Early CLI work attempted to
export a TypeScript subtree into `yaffle-dot-dev/cli`. That model created two sources of truth and
continued publishing a deprecated implementation after the Rust engine became canonical.

## Decision

- `yaffle-dot-dev/cli` directly owns the complete Rust workspace, community files, CI, tags, and
  release artifacts.
- A developer may keep that repository as an ignored nested checkout at `cli/` for cross-repository
  work. The parent repository does not track, export, or import it.
- `yaffle-dot-dev/demo` likewise owns its repository when checked out under `demo/`.
- `actions/outputs-action` continues to use guarded bidirectional tree sync because its source still
  lives at a clean parent-repository subtree.
- Cross-repository automation uses short-lived GitHub App installation tokens rather than personal
  access tokens.

## Consequences

- CLI changes, reviews, tags, and releases happen from the CLI repository root.
- The parent control plane and CLI can evolve together locally without conflating their histories.
- CLI releases cannot accidentally publish Bun, parent-only files, internal secrets, or stale
  monorepo paths.
- Cross-repository API changes require coordinated reviews in both repositories.
- The Outputs Action import guard remains necessary before parent exports.
