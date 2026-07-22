# Terraform Variable Injection Internals

The public variable and templating reference lives at
<https://yaffle.dev/docs/reference/configuration/#variable-templating>. Its source is
`apps/docs/src/content/docs/reference/configuration.mdx`. Do not duplicate the public
variable table or Terraform examples here.

## Implementations

- Rust engine injection: `cli/crates/yaffle-engine/src/lib.rs` in the nested CLI checkout
- Hosted TypeScript context: `apps/control-plane/src/lib/workspace-variables.ts`
- Template rendering: `apps/control-plane/src/lib/templating.ts`
- Legacy local declaration injection: `apps/control-plane/src/lib/state.ts`

## Developer Invariants

- `environment` is the canonical environment name.
- `environment_kind` describes managed runtime lifetime only: `named` or `transient`.
- Trigger metadata is a separate concern. `pr_number` is populated only when the source
  is a GitHub pull request; other transient environments receive `null`.
- Provider resource names and scopes normally come from customer Terraform. During beta,
  collision-prone resources may need the environment name in their configuration.
- Workspaces may explicitly opt into `automatic_preview_isolation`. The opt-in applies only to
  managed transient environments and fails closed before planning when provider/resource behavior
  is forbidden, unsupported, or still requires Cloud review.
