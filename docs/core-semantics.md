# Yaffle Core Semantics

This document is the repo-local engineering reference for Yaffle's core product
semantics.

It consolidates the decisions made in Project 0 so implementation work can use a
single local source of truth.

Linear remains the decision log and rationale trail. This file is the practical
reference engineers should reach for first.

## Source docs

- CLI and cloud semantic contract: <https://linear.app/yaffledev/document/cli-and-cloud-semantic-contract-37f605dcfcba>
- Workspace lifecycle vector and environment reduction: <https://linear.app/yaffledev/document/workspace-lifecycle-vector-and-environment-reduction-1adf355d4908>
- Scope model for lifecycle items: <https://linear.app/yaffledev/document/scope-model-for-lifecycle-items-ed3db8f85f31>
- Environment conditions and lifecycle handoff semantics: <https://linear.app/yaffledev/document/environment-conditions-and-lifecycle-handoff-semantics-d70c2da05c96>
- Materialization state and partial destroy semantics: <https://linear.app/yaffledev/document/materialization-state-and-partial-destroy-semantics-e79b6aac0882>
- Local vs cloud capability boundary: <https://linear.app/yaffledev/document/local-vs-cloud-capability-boundary-1ec5c525271a>
- Target resolution semantics for local and cloud: <https://linear.app/yaffledev/document/target-resolution-semantics-for-local-and-cloud-5d53780e9969>
- Canonical yaffle command tree and aliases: <https://linear.app/yaffledev/document/canonical-yaffle-command-tree-and-aliases-b89073b71aec>
- Dependency invalidation and downstream staleness semantics: <https://linear.app/yaffledev/document/dependency-invalidation-and-downstream-staleness-semantics-e0499d131f36>
- Canonical user stories and parity fixtures: <https://linear.app/yaffledev/document/canonical-user-stories-and-parity-fixtures-cf92c1433cf4>

## Product boundary

Yaffle has one core model and two backends:

- local CLI backend
- cloud backend

The core model is shared. Cloud adds capability; it does not redefine the
product.

### Shared capabilities

- `yaffle.toml` config model
- workspace graph and dependency planning
- named environments
- transient environments as a concept
- single-repo orchestration
- environment lifecycle semantics
- environment conditions
- materialization semantics
- `converge`, `destroy`, `status`, `wait`, `outputs`, `graph`, `doctor`
- single-repo outputs resolution
- partial truth and degraded-state semantics

### Cloud-only capabilities

- forge integration and webhook ingestion
- automatic transient lifecycle from PR/MR events
- PR comments, checks, links, and review workflow integration
- managed credentials / connections in the cloud runner path
- remote runs
- durable shared API
- durable run history and persistence
- cross-repo workspace modules
- named -> transient dependency resolution across repos
- platform-team ownership workflows across repos
- collaboration, approvals, audit, notifications, and RBAC

### Local-only assumptions

- single operator
- local credentials
- local execution
- local provider credentials remain bring-your-own via env/profile/config
- no durable shared API
- no always-on webhook receiver
- no forge-native event lifecycle

Local mode may be compatible with OpenTofu-compatible backends, but backend
compatibility is not a separately supported product tier.

### Local-first cloud assist

Local-first does not mean local-only.

The local CLI may explicitly use Yaffle Cloud for:

- hosted output-module publish/read transport on `yaffle.dev`
- short-lived execution credentials for module/backend auth
- raw `tofu` bootstrap through `yaffle tf login`

This does not make provider execution remote. Providers still run locally and
provider credentials remain local.

## Canonical nouns

### Workspace

A workspace is a single orchestrated infrastructure unit defined by repo
config.

A workspace:

- has a path in the repo
- can depend on other workspaces
- can produce outputs
- contributes lifecycle facts to an environment

### Environment

An environment is a named instance of a workspace graph.

All state-changing commands operate against an environment.

### Named environment

A long-lived, stable environment, for example:

- `main`
- `staging`
- `demo`

### Transient environment

A temporary environment created for a bounded purpose or lifetime, for example:

- `pr-7`
- `review-foo`

The canonical public identity for both named and transient environments is the
environment name.

### Outputs

Outputs are the stable exported values produced by a workspace for an
environment.

They are the official handoff surface between workspaces and higher-level
orchestration.

### Converge

Make the targeted environment match the current desired configuration and
revision.

### Destroy

Tear down the targeted environment or targeted subset in dependency-safe reverse
order.

### Graph

The dependency structure of workspaces and their ordering constraints.

## Canonical CLI surface

The launch CLI is:

```text
yaffle init
yaffle converge
yaffle destroy
yaffle status
yaffle wait
yaffle outputs
yaffle graph
yaffle doctor
yaffle tf login

yaffle cloud login
yaffle cloud logout
yaffle cloud status
```

`yaffle tf login` is the explicit raw-`tofu` bridge. It emits shell exports for
the current shell session and does not mutate global Terraform login state by
default.

### Targeting rules

For v1, these commands require explicit `--env`:

- `converge`
- `destroy`
- `status`
- `wait`
- `outputs`

`graph` may omit `--env` and show the static repo graph. `graph --env <name>`
shows the environment-resolved graph.

Subset operations use repeatable `--workspace` flags:

```bash
yaffle converge --env main --workspace app/ml
yaffle destroy --env pr-7 --workspace apps/docs/infra
```

There are no canonical aliases in v1.

## Target resolution

The canonical public target is always an environment name:

```ts
interface EnvironmentTarget {
  environment: string
}
```

Workspace subset selection is a separate concern:

```ts
interface WorkspaceSelection {
  workspaces?: string[]
}
```

Rules:

- `--env` answers which environment
- repeated `--workspace` answers which subset inside that environment
- selection narrows the operation; it does not change the environment target

For v1, local state-changing commands do not infer targets from:

- Git branch
- `jj` change
- PR number
- repo defaults
- `yaffle.toml` branch patterns

Cloud may derive targets from forge events or API requests internally, but the
final semantic target must still reduce to the same environment concept.

## Lifecycle algebra

Environment state is not binary.

Yaffle models lifecycle truth as a reduction over workspace lifecycle vectors.

### Lifecycle phases

- `infra`
- `activation`
- `verification`
- `teardown`

### Lifecycle states

```ts
type LifecycleState =
  | "pending"
  | "running"
  | "succeeded"
  | "degraded"
  | "blocked"
  | "failed"
```

### Phase vector

```ts
interface PhaseVector {
  pending: number
  running: number
  succeeded: number
  degraded: number
  blocked: number
  failed: number
}
```

The numbers are counts of lifecycle items in each state.

### Lifecycle items are first-class

The atomic unit is a lifecycle item, not a workspace summary:

```ts
type PhaseName = "infra" | "activation" | "verification" | "teardown"

interface LifecycleItem {
  key: string
  phase: PhaseName
  kind: string
  state: LifecycleState
  metadata?: Record<string, unknown>
  scopes?: string[]
}
```

### Output facts

```ts
type OutputState = "missing" | "stale" | "ready"

interface OutputVector {
  missing: number
  stale: number
  ready: number
}

interface OutputFact {
  name: string
  state: OutputState
  metadata?: Record<string, unknown>
}
```

### Workspace lifecycle state

```ts
interface WorkspaceLifecycleVector {
  infra: PhaseVector
  activation: PhaseVector
  verification: PhaseVector
  teardown: PhaseVector
  outputs: OutputVector
}

interface WorkspaceLifecycleState {
  workspacePath: string
  items: LifecycleItem[]
  outputs: OutputFact[]
  vector: WorkspaceLifecycleVector
}
```

`items` and `outputs` are the source of truth. `vector` is deterministic derived
state.

### Reduction

Workspace reduction:

```ts
workspace.vector.infra[state] =
  count(workspace.items where phase == "infra" && item.state == state)

workspace.vector.activation[state] =
  count(workspace.items where phase == "activation" && item.state == state)

workspace.vector.verification[state] =
  count(workspace.items where phase == "verification" && item.state == state)

workspace.vector.teardown[state] =
  count(workspace.items where phase == "teardown" && item.state == state)

workspace.vector.outputs[state] =
  count(workspace.outputs where output.state == state)
```

Environment reduction:

```ts
environment.vector = sumComponentWise(all workspace vectors)
```

No precedence or weighting is applied at this layer.

### Derived summaries

`mixed` is never stored as primary state. It is a derived summary over a vector.

For phase vectors:

- if total count is `0` -> `idle`
- if exactly one bucket is non-zero -> return that bucket name
- otherwise -> `mixed`

The same rule applies to outputs with `missing`, `stale`, and `ready`.

## Scope model

Scopes are projections over lifecycle items. They do not replace the base
vectors.

Every lifecycle item contributes to the base vector. Scopes create additional
filtered views used for conditions, policy, and blocking behavior.

### Scope set

- `infra_dag`
- `usable`
- `acceptable`
- `teardown`

### Meanings

- `infra_dag`: determines whether downstream infrastructure workspaces may proceed
- `usable`: determines whether the environment is practically usable
- `acceptable`: determines whether the environment has met the threshold for a trusted next step
- `teardown`: determines whether cleanup/destruction has completed cleanly enough to trust the cleanup outcome

### Default scope assignments

- `infra` items -> `infra_dag`, `usable`, `acceptable`
- `activation` items -> `usable`, `acceptable`
- `verification` items -> `acceptable`
- `teardown` items -> `teardown`

Items with no scopes are advisory-only:

- they contribute to the base vector
- they can make the global summary `mixed` or `degraded`
- they do not affect `infra_dag`, `usable`, `acceptable`, or `teardown`

### Async activation

Activation is async-by-default relative to the workspace DAG:

- downstream infra progression is governed by `infra_dag`
- activation and verification do not block infra progression unless explicitly opted into `infra_dag`

## Environment conditions

Environment conditions are env-level derived predicates. They are not
workspace-level scheduler primitives.

Internal prerequisites are workspace/item-level and drive orchestration.
Environment conditions are the public truth exposed to users and integrations.

### Condition shape

```ts
type EnvironmentConditionName =
  | "infra_ready"
  | "activation_settled"
  | "verification_settled"
  | "usable"
  | "acceptable"
  | "teardown_settled"

interface EnvironmentCondition {
  name: EnvironmentConditionName
  met: boolean
  summary: "idle" | "progressing" | "succeeded" | "degraded" | "blocked" | "failed" | "mixed"
  reason?: string
  metadata?: Record<string, unknown>
}
```

### Initial condition set

- `infra_ready`
- `activation_settled`
- `verification_settled`
- `usable`
- `acceptable`
- `teardown_settled`

### Predicates

`infra_ready`
- basis: `infra` items in `infra_dag`
- met iff `pending == 0`, `running == 0`, `blocked == 0`, `failed == 0`, `degraded == 0`

`activation_settled`
- basis: all `activation` items
- met iff `pending == 0` and `running == 0`

`verification_settled`
- basis: all `verification` items
- met iff `pending == 0` and `running == 0`

`usable`
- basis: items in `usable`
- met iff `pending == 0`, `running == 0`, `blocked == 0`, `failed == 0`
- `degraded` does not block `usable`

`acceptable`
- basis: items in `acceptable`
- met iff `pending == 0`, `running == 0`, `blocked == 0`, `failed == 0`, `degraded == 0`

`teardown_settled`
- basis: items in `teardown`
- met iff `pending == 0` and `running == 0`

### Important consequence

An environment can have:

- `infra_ready = met`
- `usable = met`
- `acceptable = unmet`

This is correct and intentional.

## Materialization and partial destroy

Materialization is a distinct semantic dimension.

It answers: what currently exists?

### Workspace materialization

```ts
type WorkspaceMaterialization =
  | "absent"
  | "materializing"
  | "present"
  | "partially_present"
  | "dematerializing"
  | "residual"
```

Meaning:

- `absent`: no materialized resources are intended to remain
- `materializing`: creation/update toward presence is in progress
- `present`: intended materialization exists
- `partially_present`: only some intended materialization exists, or converged truth is incomplete
- `dematerializing`: targeted teardown is in progress
- `residual`: intended teardown happened, but residual resources or cleanup debt remain

### Environment materialization

```ts
type EnvironmentMaterialization =
  | "absent"
  | "materializing"
  | "present"
  | "partially_present"
  | "dematerializing"
  | "residual"
```

Reduction rule:

- if all workspaces are `absent` -> `absent`
- else if any workspace is `dematerializing` -> `dematerializing`
- else if any workspace is `residual` -> `residual`
- else if all workspaces are `present` -> `present`
- else if any workspace is `materializing` -> `materializing`
- else if any workspace is `partially_present` -> `partially_present`
- else if there is a mix of `present` and `absent` -> `partially_present`

### Destroy target semantics

Destroy is always relative to a target set:

```ts
type DestroyTarget =
  | { type: "environment" }
  | { type: "workspace"; workspace: string }
  | { type: "workspace_set"; workspaces: string[] }
```

### Destroy outcome

Destroy returns operation-scoped truth, not an env-level `destroyed` condition:

```ts
type DestroyOutcome =
  | "pending"
  | "running"
  | "settled_clean"
  | "settled_residual"
  | "blocked"
  | "failed"
  | "mixed"
```

Meaning:

- `settled_clean`: teardown settled and the target set was fully removed
- `settled_residual`: teardown settled but residuals remain for the target set

This means an environment can still be `usable` while a partial destroy target has
completed cleanly or with residuals.

## Dependency invalidation and freshness

Freshness is separate from lifecycle and materialization.

It answers: does this workspace still reflect current dependency truth?

### Freshness states

```ts
type WorkspaceFreshness =
  | "fresh"
  | "in_flux"
  | "stale"

type EnvironmentFreshness =
  | "fresh"
  | "in_flux"
  | "stale"
```

Meanings:

- `fresh`: reflects current dependency truth
- `in_flux`: one or more dependencies are currently mutating or being destroyed, so freshness cannot yet be determined reliably
- `stale`: one or more dependencies changed in a dependency-relevant way and this workspace has not been reconciled yet

Reduction:

- if any workspace is `stale` -> environment freshness = `stale`
- else if any workspace is `in_flux` -> environment freshness = `in_flux`
- else -> `fresh`

### v1 invalidation rule

Yaffle uses pessimistic invalidation in v1.

If upstream `Y` is targeted for mutation or destroy and downstream `X` depends on
`Y`:

- while `Y` is mutating -> `X = in_flux`
- when `Y` settles with dependency-relevant change -> `X = stale`
- when `X` reconciles successfully -> `X = fresh`

### Relationship to outputs and conditions

- stale workspace => stale published outputs
- `in_flux` workspace does not automatically make outputs `stale` yet
- freshness does not automatically block `usable`
- freshness must block `acceptable`

Important consequence:

- a subset converge can leave the targeted subset converged
- while untargeted downstream workspaces are `stale`
- therefore the environment may remain `usable` but not `acceptable`

## Local vs cloud visibility and API boundary

Local and cloud share semantic truth, but not the same durability surface.

### Local

Local may expose:

- current environment conditions
- current materialization state
- current freshness state
- current outputs
- current graph resolution
- current diagnostics

Local does not promise:

- durable shared run history
- multi-user visibility
- stable historical audit records
- a supported public local API

### Cloud

Cloud may expose all of the above plus:

- durable run history
- durable environment records
- repo/workspace/run associations
- multi-user visibility
- forge-linked execution history
- durable API-backed inspection of remote runs

### Local API decision

For v1, any local API/daemon/service is internal-only.

The supported local public surfaces are:

- the CLI
- machine-readable CLI output such as `--json`

## Unsupported local behavior

When a repo or workflow depends on cloud-only capability, local CLI must fail
explicitly.

Examples:

- `cross-repo workspace resolution requires Yaffle Cloud`
- `this action requires a cloud-backed repo or environment record and cannot run in local mode`
- `this repository depends on Yaffle Cloud-only workflow capabilities and cannot be executed purely locally`

The CLI must not:

- silently drop cross-repo dependencies
- silently ignore cloud-only repo/workflow requirements
- silently fabricate forge or cloud context
- pretend it is brokering provider credentials when it is only running OpenTofu locally

## Canonical user stories

The semantic model must support at least these story classes cleanly:

- first successful local infrastructure creation
- local multi-workspace DAG converge
- local transient environment creation
- cloud forge-driven transient environments
- infra success with activation failure
- usable but not acceptable environments
- advisory-only failures
- downstream infra continuing despite later activation degradation
- teardown with residual cleanup
- explicit local failure for cloud-only capability
- cloud-managed execution
- cross-repo cloud composition
- environments usable before acceptable
- pure infra repos with no activation handlers

See the full pressure-test set in:

- <https://linear.app/yaffledev/document/canonical-user-stories-and-parity-fixtures-cf92c1433cf4>

## Practical rule for engineering

When implementing local or cloud behavior:

- use lifecycle vectors for work truth
- use scopes for contextual blocking
- expose environment conditions publicly
- track materialization separately from lifecycle
- track freshness separately from lifecycle/materialization
- treat destroy as target-relative

If two implementations disagree, this document wins until the semantics are
explicitly revised in Project 0.
