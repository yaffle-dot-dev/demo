# ADR 0004: anonymous session persistence and repo binding

## Status

Accepted

## Context

Anonymous session principals are intentionally useful without a signup wall, but
they must not accidentally behave like durable user accounts.

We need explicit rules for:

- where guest credentials live locally
- how repo bindings are formed
- what happens when credentials are deleted
- whether a guest can continue on another machine
- how future account upgrade should behave

## Decision

### Local persistence

The CLI persists the active anonymous principal in a Yaffle-managed local auth
store.

- current storage path is `~/.yaffle/auth/principal.json`
- the CLI reuses that principal automatically until it expires, is revoked, or
  the file is deleted
- deleting the file is treated as intentionally discarding the guest identity

### Repo binding contract

Repo bindings are created lazily when the CLI first mints an execution token or
publishes a hosted output module for a repo.

- bindings are scoped to a principal
- bindings use the canonical repo namespace plus a machine-local repo
  fingerprint
- the local repo fingerprint is derived from the repo root on that machine
- if the canonical repo namespace cannot be inferred, local-first hosted-module
  flows fail closed

Anonymous repo bindings are revocable and non-exclusive. They do not reserve or
claim durable ownership of the namespace.

### Same-machine behavior

Same-machine continuation is supported.

- if `~/.yaffle/auth/principal.json` survives, the guest keeps using the same
  anonymous principal
- previously published hosted output modules remain readable to that principal
- if the local repo fingerprint changes because the repo moves or is recloned,
  Yaffle treats the new location as a different binding

### Deleted credentials on the same machine

If the local anonymous credential is deleted:

- local Terraform/OpenTofu state files remain wherever the repo kept them
- guest-owned hosted output modules become inaccessible through that deleted
  principal
- the next `yaffle converge` bootstraps a new anonymous principal and republishes
  fresh hosted output modules as needed

### Cross-machine behavior

Cross-machine continuation is not supported for anonymous sessions.

- copying repo files to another machine does not recover the guest identity
- copying `principal.json` manually is not a supported product path
- the supported portability story is upgrading to or signing into an account

User-facing CLI copy should say this plainly: guest sessions stay on the machine
where they were created.

### Account upgrade direction

Account upgrade should link the current anonymous principal into an
account-backed principal when possible.

- hosted output modules and repo bindings should migrate when safe
- durable ownership semantics begin only after the account-backed identity is in
  place
- `yaffle cloud login` should explicitly tell the user when it converted a
  machine-local guest session into an account-backed principal

## Consequences

- anonymous sessions stay useful for return visits on the same machine
- anonymous sessions do not become accidental portable accounts
- repo ownership semantics remain clean for future account/org-backed product
  flows
- implementation can fail closed whenever repo identity is ambiguous
