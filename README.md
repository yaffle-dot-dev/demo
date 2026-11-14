# Yaffle Local-Only Orchestration Demo

This repository exercises Yaffle plans, automatic applies, outputs, and teardown
without provisioning cloud infrastructure. It contains no AWS or Cloudflare
resources and needs no cloud-provider credentials.

The six OpenTofu workspaces use only `terraform_data` and the `null`, `random`,
`time`, and `local` providers:

| Workspace                 | Purpose                                                   | Side effects                             |
| ------------------------- | --------------------------------------------------------- | ---------------------------------------- |
| `infra/core`              | Project settings, monitoring flags, and rotation metadata | State only                               |
| `infra/database`          | Simulated database instances and backup settings          | State only                               |
| `infra/app`               | Simulated network and application configuration           | State only                               |
| `infra/feature-flags`     | Environment-specific feature flags                        | State only                               |
| `infra/sandbox`           | Sandbox metadata and experiment variants                  | State only                               |
| `infra/preview-isolation` | Automatic preview naming                                  | A file in the runner's working directory |

Names such as database, network, and monitoring represent fixtures, not deployed
services. Hosted execution still uses Yaffle's runner and state-storage services;
the demo itself does not create cloud resources.

## Serial-push graph and timing

All six workspaces are selected in **every** named and pull-request environment.
Every selected dependency is therefore included, not silently filtered out.
There are no approval rules, including for the local-only `production` environment.
This is an execution test fixture, not a production approval-policy example.

| Workspace                 | `depends_on` (upstream must finish first) | Wait per new revision |
| ------------------------- | ----------------------------------------- | --------------------: |
| `infra/core`              | none                                      |                    2s |
| `infra/database`          | `infra/core`                              |                   60s |
| `infra/feature-flags`     | `infra/core`                              |                    3s |
| `infra/app`               | `infra/database`, `infra/feature-flags`   |                    3s |
| `infra/preview-isolation` | `infra/app`                               |                    2s |
| `infra/sandbox`           | none (independent branch)                 |                   10s |

Core fans out to database and feature-flags; app joins both branches; preview-isolation
is a final downstream stage. Sandbox is independent of the entire chain. These are
Yaffle scheduling edges, not remote-state reads or external callbacks.

Each workspace has a `time_sleep.revision` resource. Its `triggers.revision` is
`variables.test_revision` from that workspace's TOML block. Changing the marker
replaces an actual planned resource, repeats the local create-time wait, and writes
the applied marker to the `test_revision` output. An output-only change or no-op
push would not reliably exercise apply ordering. Reusing the same marker is a
no-op for this resource. The marker does not contain or derive from wall-clock time.
Waits are whole seconds, validated between 0 and 120; there is no destroy-time wait.
The other fixtures retain their random IDs and rotation metadata, so assert the
revision output rather than expecting all existing outputs to be deterministic.

With sufficient runner capacity, feature-flags should finish while database is
still applying; app and preview-isolation should remain pending. Sandbox can
finish independently. The nominal critical-path sleep is 67s; runner startup,
planning, and scheduling add overhead. Observe statuses, not a fixed stopwatch
deadline. If capacity serializes all work, this graph alone cannot demonstrate
overlap; arrange concurrent runner capacity before judging that observation.

## Drive A / B / C pushes

Run these commands only when intentionally performing hosted acceptance. Local
validation below does not push or contact a live Yaffle environment.

1. Prepare a commit with **all six** `variables.test_revision` entries set to `A`
   (use a fresh prefix, such as `trial2-A`, when reusing an existing environment).
   Keep delay values unchanged. Commit the graph changes as well on the first run.
2. For paired acceptance, push the **same commit** to both existing branch refs:

   ```bash
   git push origin HEAD:refs/heads/acceptance/handoff-candidate-262 HEAD:refs/heads/acceptance/handoff-control-261
   ```

   The standalone acceptance fixture maps those exact refs to
   `handoff-candidate-262-v2` and `handoff-control-261-v2`, respectively. These fresh
   environment scopes preserve the original acceptance history, including the
   held candidate revision; they do not repair or release that revision. The canonical
   `demo/` source intentionally has no acceptance-specific declarations or triggers;
   retain the standalone overlay when syncing it. Main/staging/develop push
   triggers and the pull-request trigger are otherwise unchanged.

3. Wait until A's core and feature-flags have finished, database is still running,
   and app/preview-isolation are pending. Record the environment, commit SHA,
   run-group IDs, workspace states, and timestamps on each side.
4. Change all six markers from A to B, commit, and push that same B commit to
   both refs. For example, from the fixture root on GNU/Linux:

   ```bash
   sed -i 's/^variables.test_revision = "A"$/variables.test_revision = "B"/' yaffle.toml
   git add yaffle.toml
   git commit -m 'exercise revision B'
   git push origin HEAD:refs/heads/acceptance/handoff-candidate-262 HEAD:refs/heads/acceptance/handoff-control-261
   ```

5. While A still holds the slow branch, repeat B -> C and push the same C commit
   to both refs. Do not wait for B to apply: that would remove the queued-revision
   pressure needed to investigate coalescing. Check A is still running before C;
   if the window was missed, repeat with fresh markers, not larger unbounded waits.
6. After convergence, inspect **all six** `test_revision` outputs and source SHAs.
   They must agree on C for each environment. A stale A/B marker anywhere exposes
   incomplete convergence. Capture intermediate outputs too: a final C alone
   cannot prove correct admission ordering or that B was coalesced.

### What is implemented versus under test

Implemented here: the complete DAG, automatic configuration (no manual approval
gates), bounded asymmetric apply waits, and resource-backed revision outputs.
This fixture does **not** implement or prove candidate admission or coalescing.
Those behaviors belong to the control plane and depend on the deployed build.

The admission safety assertion under investigation is that an admitted A retains
its **entire unfinished DAG**, including pending app and preview-isolation, until
completion; B/C must not start conflicting work merely because A's fast workspace
is done. A successor must not strand or silently cancel A's downstream work.
Compare candidate and control timelines explicitly; do not treat either build's
behavior as already proven by this fixture.

Future coalescing expectation (not a claim of current support): if B and C both
arrive while A owns admission, only the latest eligible queued revision C should
be admitted after A, with B observably superseded/skipped rather than mutated.
If B and then C both run serially, record that as admission serialization without
coalescing, not as a coalescing pass. A/B/C must not overlap conflicting workspace
mutation or cross environment/state boundaries. These waits create the observation
window; they are not locks and cannot enforce control-plane safety themselves.

## Automatic OpenTofu preview isolation

The `infra/preview-isolation` workspace configures one stable filename:

```toml
variables.resource_name = "yaffle-product-demo"
```

Yaffle materializes an isolated name for a pull request without rewriting the
repository source.

| Event                          | Environment   | Materialized filename                 |
| ------------------------------ | ------------- | ------------------------------------- |
| Pull request opened or updated | `pr-{number}` | `yaffle-product-demo-{stable-suffix}` |
| Pull request closed            | `pr-{number}` | Preview file destroyed                |
| Push to `main`                 | `production`  | `yaffle-product-demo`                 |

The pinned `hashicorp/local` `2.5.3` provider exercises provider resolution,
immutable source transformation, plan, apply, outputs, and destroy without a
cloud account.

## Run the demo

Install the Yaffle GitHub App for this repository and connect it to your Yaffle
organization. No AWS or Cloudflare connection is required.

1. Create a branch and change all six `variables.test_revision` values in `yaffle.toml`.
2. Open a pull request.
3. Watch Yaffle plan the selected workspaces under one `pr-{number}` environment.
4. Watch automatic applies follow the DAG without manual approval gates.
5. Inspect revision outputs and the materialized filename.
6. Close the pull request and watch Yaffle tear down the preview fixtures.

Named-environment selection and push triggers are defined in `yaffle.toml`.

## Previously deployed resources

Removing the former cloud workspace from source does not prove its existing
resources were destroyed. Any previously deployed Worker, KV namespace, or
Alchemy state-store resources require a separate, explicitly authorized cleanup.

## Validate locally

Use a disposable copy so state, plan files, and the preview file never land in
the source checkout. There is no remote backend. Initialize with `-backend=false`
and validate **all six** workspaces, not just preview-isolation. For example:

```bash
scratch=$(mktemp -d)
cp -R infra "$scratch/infra"
tofu -chdir="$scratch/infra" fmt -check -recursive
for workspace in "$scratch"/infra/*; do
  tofu -chdir="$workspace" init -backend=false -input=false -lockfile=readonly
  tofu -chdir="$workspace" validate
done
rm -rf "$scratch"
```

For local plans/applies, pass each workspace's TOML variables as a JSON tfvars
file and set `environment` to a fixed test name (replace the `{{ environment }}`
template). Apply A, change `test_revision` to B then C, and assert each plan
replaces `time_sleep.revision`, each applied output matches, and a repeated C
plan has no changes. A local OpenTofu invocation knows only its own workspace;
it does not exercise Yaffle's cross-workspace scheduler, admission, or coalescing.
