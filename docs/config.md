# Configuration Implementation Notes

The public `yaffle.toml` contract is documented at
<https://yaffle.dev/docs/reference/configuration/>. Its source of truth is
`apps/docs/src/content/docs/reference/configuration.mdx`. Do not duplicate the public
field reference or setup examples in this file.

## Parser Implementations

Yaffle currently has two native parser implementations:

- TypeScript control plane: `apps/control-plane/src/lib/config-toml.ts`
- Rust CLI and engine: `crates/yaffle-config/src/lib.rs`

Both parse TOML, apply defaults and aliases, normalize the public model, and validate
semantic invariants. This is duplicated implementation, not two separate contracts.
Changes to one parser must include equivalent behavior and tests in the other.

The parsers already differ in some normalized types and validation details. The intended
deep seam is a language-neutral conformance corpus under `testdata/config/v1/` containing:

- valid TOML and expected normalized JSON
- invalid TOML and expected stable error codes/paths

Both native adapters should consume that corpus. Bun should not invoke Rust, and Rust
should not invoke Node, at runtime merely to share parsing.

## Developer Invariants

- Config schema version `1` is the only accepted public version.
- Cloud-only triggers and approvals live under `[cloud]`; legacy top-level forms fail.
- Runtime `EnvironmentKind` (`named` or `transient`) is distinct from ownership class.
- GitHub pull-request environments use `pr-{number}`. Other transient sources are not
  required to use PR-shaped names.
- Public documentation examples are validated by `scripts/public-configs.test.ts`.
- The repository and published demo are parsed by the Rust config tests.

## Related Internals

- Graph selection: `crates/yaffle-graph/src/lib.rs`
- Hosted execution config loading: `apps/control-plane/src/routes/cloud-converge.ts`
- Local engine config loading: `crates/yaffle-engine/src/lib.rs`
- Script/CI config loading: `scripts/ci/config.ts`
