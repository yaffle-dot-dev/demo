# ADR 0002: local-first principals and hosted output modules

## Status

Accepted

## Context

Yaffle's local-first flow now depends on normal `tofu init` module resolution
against the canonical `yaffle.dev` host rather than local filesystem module
rewriting.

We want the first successful local path to be:

- install `yaffle`
- initialize or write `yaffle.toml`
- run `yaffle converge`
- let the CLI obtain a Yaffle principal
- publish upstream outputs as Yaffle-hosted output modules
- let downstream `yaffle.dev/.../yaffle` references resolve through normal
  Terraform/OpenTofu transport

We also want a supported escape hatch for raw `tofu` so users do not need to rip
Yaffle module sources out of their configs when debugging.

## Decision

### Principal model

Yaffle has one core actor abstraction: a principal.

- principal types are `account` and `anonymous_session`
- principals authenticate to `yaffle.dev`
- principals own hosted output modules and provide the identity used for
  lifecycle, service protection, and audit attribution
- anonymous sessions are first-class principals, not disguised user accounts

### Credential model

Yaffle uses two credential layers.

1. A machine-local principal credential stored by the CLI
2. A short-lived execution credential minted for a specific repo, environment,
   and consumer workspace

The CLI keeps the principal credential and exchanges it for workspace-scoped
execution credentials before local `tofu` execution.

### How Yaffle hands auth to Terraform/OpenTofu

For Yaffle-managed execution:

- `yaffle` loads or bootstraps the principal credential
- `yaffle` mints a short-lived execution credential for the active
  repo/environment/workspace
- `yaffle` writes a scoped Terraform/OpenTofu credentials file
- `yaffle` runs `tofu` with `TF_CLI_CONFIG_FILE` pointing at that file

In the engine-managed local-first path, this credential is minted per workspace
immediately before that workspace's `tofu init` and is expected to cover module
resolution plus any immediate follow-on registry fetches for that workspace.

The CLI writes a host credential for `yaffle.dev` and may also rewrite the
transport host inside temporary execution repos when
`YAFFLE_MODULE_API_HOST` is set for local development.

For raw `tofu`, the supported bridge is:

```bash
eval "$(yaffle tf login --env <env> --workspace <workspace>)"
```

`yaffle tf login` is shell-scoped by default:

- it prints shell exports instead of mutating the parent process directly
- it does not rewrite `~/.terraformrc` globally by default
- it emits distinct scoped config files so multiple env/workspace sessions can
  coexist
- because raw `tofu plan` and `tofu apply` can run much longer than `init`, the
  shell-scoped credential should have a materially longer TTL than the
  engine-managed per-workspace init credential

### Hosted output modules

Hosted output modules are Yaffle-generated module artifacts derived from
workspace outputs.

- they are not generic user-managed module hosting
- the authored source host remains `yaffle.dev`
- publish/read scope is principal + repo binding + environment + workspace
- module resolution context comes from the short-lived execution credential, not
  from encoding environment details into the source path

### Repo bindings and ownership

Anonymous principals may create repo bindings, but they do not claim durable
ownership of a public-looking namespace.

- repo bindings are scoped to a principal
- bindings use both canonical repo namespace and a local repo fingerprint
- durable ownership semantics belong only to account- or org-backed principals

### Same-machine and cross-machine behavior

- same-machine anonymous-session reuse is supported while the stored principal
  credential survives
- deleting the local anonymous credential loses access to the old hosted output
  modules owned by that guest principal
- cross-machine continuation for anonymous sessions is not supported
- guest-to-account upgrade is a required future path, but not part of the first
  implementation slice

### Canonical host and dev override

- `yaffle.dev` is the only canonical authored module/backend host
- `YAFFLE_MODULE_API_HOST` is a runtime transport override for local development
- user-authored configuration should not bake in `localhost`, `yaffle.local`,
  or other dev-only hosts

### Cloud POC stance

The current cloud/control-plane system is a reference implementation, not an
architectural boundary.

- keep transport-correct registry/discovery pieces where they help
- replace or heavily refactor auth and resolution flows that assume cloud-only
  named-user callers
- prefer a clean principal-scoped backend over layering more logic on top of the
  old local rewrite model

## Consequences

- local-first is not local-only; local execution remains local, but hosted
  output-module transport uses Yaffle Cloud
- provider credentials remain bring-your-own via local env/profile/config
- Yaffle explicitly brokers backend/module auth for `yaffle.dev`
- raw `tofu` fallback remains a supported recovery and debugging path
- anonymous-session policy thresholds and lifecycle details are tracked in
  `docs/decisions/0003-anonymous-session-abuse-quota-and-gc.md`
- anonymous-session persistence, repo binding, and portability details are
  tracked in
  `docs/decisions/0004-anonymous-session-persistence-and-repo-binding.md`
