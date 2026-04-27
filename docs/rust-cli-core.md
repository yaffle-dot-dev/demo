# Rust CLI Core

This document is the local engineering reference for the Rust CLI/bootstrap
direction introduced in Project 1.

It complements `docs/core-semantics.md` by describing the implementation layout
rather than the product semantics.

## Source docs

- CLI alpha implementation breakdown: <https://linear.app/yaffledev/document/cli-alpha-implementation-breakdown-465cd63a5f50>
- Rust engine contract and cloud shell boundary: <https://linear.app/yaffledev/document/rust-engine-contract-and-cloud-shell-boundary-74150a5fcf0e>

## Direction

Yaffle is moving to:

- Rust local CLI shell
- Rust semantic engine
- TypeScript cloud shell

The old TypeScript CLI command surface is deprecated and should not be used as
the forward architecture.

## Rust workspace layout

The initial Rust workspace lives at the repo root and currently contains:

- `crates/yaffle-cli`
- `crates/yaffle-contracts`
- `crates/yaffle-config`
- `crates/yaffle-engine`
- `crates/yaffle-graph`
- `crates/yaffle-tofu`

These crate boundaries are intentionally lightweight for now. They exist to keep
the Rust path moving without re-deciding layout every time we touch the CLI.

## Framework decision

Project 1 is expected to use:

- `clap` for command tree, parsing, help, and shell completion foundations

This is the chosen direction unless explicitly revised in Linear.

## Current status

The Rust shell is allowed to be hollow initially.

That means:

- the canonical command tree exists
- command parsing and help are real
- command execution may still return placeholder summaries while engine behavior is implemented

This is intentional for the CLI alpha phase.

## Tofu strategy

The CLI alpha should not assume system `tofu` is the long-term user story.

Instead, Project 1 should shape:

- a first `tofu` acquisition/distribution strategy
- a stable abstraction for how the CLI locates and invokes `tofu`

This does not require final bundling/embedding yet, but it must be part of the
architecture from the start.

The current frozen CLI alpha policy is:

- prefer an explicit override when provided
- otherwise prefer a bundled sidecar toolchain
- otherwise prefer a Yaffle-managed cached toolchain
- fall back to system `tofu` only as a compatibility path

The initial Rust abstraction for this lives in `crates/yaffle-tofu`.

## Local entrypoint

For now, the repo-level command is:

```bash
bun run yaffle -- ...
```

which delegates to:

```bash
cargo run -p yaffle-cli -- ...
```

This is an interim dogfooding path and may evolve as packaging is finalized.

## Implementation rule

When building the Rust CLI/core:

- follow `docs/core-semantics.md` for product semantics
- follow the Linear engine contract doc for the CLI/engine/cloud boundary
- do not add new semantic behavior in the shell without updating the semantic source docs first
