# Traffic Controller

Internal-only Hookdeck traffic control for Yaffle devex.

This service is responsible for:

- storing routeable deployment state
- storing live webhook lease state
- authorizing lease operations
- reconciling Hookdeck destinations, preview allow connections, and prod exclusions
- repairing routing drift

This service is intentionally **not** customer-facing.

## Build And Deploy

Build the Lambda bundles:

```bash
nix run .#build-tc
```

Deploy the traffic-controller Lambdas to `main`:

```bash
nix run .#deploy-tc -- --env main
```

Useful flags:

- `--skip-build` to reuse existing bundles
- `--api-only` to deploy only the API Lambda
- `--reconcile-only` to deploy only the reconcile Lambda

## Boundary

- `control-plane`: receives and handles webhooks normally
- `traffic-controller`: owns lease policy and Hookdeck mutation
- `Hookdeck`: enforces runtime delivery

`control-plane` and `traffic-controller` do not directly communicate.

## CI Flow

### 1. Preview deployment publishes routeable deployment facts

After preview deploy succeeds, CI calls `ensure_routeable_deployment` with:

- deployment id
- PR number
- owner GitHub user id/login
- receiver URL
- receiver kind
- desired state `active`

This keeps traffic-controller independent from control-plane internals while still letting it reason about eligible webhook destinations.

### 2. Lease intent is explicit

Live routing should not happen automatically for every PR.

Preferred intent mechanism:

- PR comment command, or
- PR label plus comment-driven parameters

CI parses that intent and calls `ensure_live_webhook_lease`.

### 3. Traffic-controller owns async semantics

CI waits on traffic-controller operation state, not Hookdeck directly.

Traffic-controller may be eventually consistent underneath, but its public internal contract should provide tighter semantics:

- operation accepted
- operation running
- operation succeeded
- operation failed
- operation rejected

### 4. PR close / merge tears leases down

PR close or merge CI calls `ensure_live_webhook_lease` with desired state `absent`, or an explicit revoke command.

### 5. Drift repair is periodic

EventBridge cron invokes reconciliation sweep logic to:

- detect stale preview destinations
- revoke stale leases
- repair missing Hookdeck objects
- repair incorrect production exclusions

## Test Matrix

### Contract tests

- valid command payloads parse
- invalid payloads fail with deterministic validation errors
- operation status and response contracts are stable

### State-machine tests

- requested -> active
- requested -> rejected
- active -> revoking -> revoked
- retry after partial Hookdeck failure converges correctly

### Hookdeck integration tests

- preview allow is created before prod exclusion on activation
- preview allow is removed before prod exclusion is removed on revocation
- production receives non-leased traffic
- preview receives leased traffic only
- drift sweep repairs missing or stale routing state

### Security tests

- non-personal scopes are rejected
- overlapping leases are rejected
- another engineer's deployment cannot be targeted
- control-plane does not hold Hookdeck routing credentials

### End-to-end tests

- comment/label intent -> CI -> traffic-controller -> Hookdeck -> preview
- PR close -> CI -> traffic-controller -> Hookdeck -> production fallback

## Database Boundary

Traffic-controller should use its own database role and only access the `traffic_control` schema.

Recommended least-privilege boundary:

- `SELECT/INSERT/UPDATE/DELETE` on `traffic_control.*`
- no access to control-plane tables

If deployment facts are needed, CI should publish them directly to traffic-controller rather than requiring traffic-controller to query control-plane state.
