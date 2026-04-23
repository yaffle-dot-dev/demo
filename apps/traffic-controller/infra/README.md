# Traffic Controller Infra

Lambda-first internal infrastructure for traffic-controller.

## Runtime Shape

- `api` Lambda: accepts internal commands from CI or other internal automation
- `reconcile` Lambda: processes async reconciliation jobs and periodic drift sweeps
- SQS queue: buffered reconciliation work
- EventBridge schedule: periodic drift repair

## Security Boundary

- `control-plane` does not receive Hookdeck routing credentials
- only `traffic-controller` Lambdas can read `HOOKDECK_API_KEY`
- traffic-controller gets its own database credentials

## Current Status

This is an infrastructure skeleton.

What exists now:

- Lambda functions and IAM roles
- reconciliation queue and DLQ
- EventBridge schedule for drift sweeps
- separate Secrets Manager secret for traffic-controller database credentials, readable only by traffic-controller Lambdas
- versioned privileged SQL bootstrap for the scoped runtime role in `apps/traffic-controller/sql/0001_runtime_role_grants.sql`
- wrapper script to apply grants and populate the runtime DB secret via `psql` + `aws` CLI

What still needs follow-up:

- code deployment workflow for the Lambda artifacts
- internal invocation path (likely CI-driven Lambda invoke)

CI should invoke the API Lambda using exported function name/ARN only. It should not need, receive, or export the traffic-controller database secret.

## Scoped Runtime Role Bootstrap

The runtime database role is intentionally not created by Terraform.

Instead, Terraform creates only the secret shell at:

- `yaffle/${environment}/traffic-controller/database-url`

Then a privileged bootstrap step applies the versioned SQL grants and stores the
runtime database URL into that secret.

The migration path intentionally accepts the admin URL too, so this works:

```bash
TRAFFIC_CONTROL_ADMIN_DATABASE_URL='postgresql://...' bun run db:migrate
```

If `TRAFFIC_CONTROL_DATABASE_URL` is unset, `drizzle.config.ts` falls back to
`TRAFFIC_CONTROL_ADMIN_DATABASE_URL` before falling back to the generic
`DATABASE_URL`.

Run:

```bash
TRAFFIC_CONTROL_ADMIN_DATABASE_URL='postgresql://...' \
TRAFFIC_CONTROL_RUNTIME_ROLE_PASSWORD='...' \
TRAFFIC_CONTROL_DATABASE_URL_SECRET_ID='yaffle/main/traffic-controller/database-url' \
bun run db:bootstrap-runtime-role
```

Optional:

- `TRAFFIC_CONTROL_RUNTIME_ROLE_NAME` to override the default `yaffle_tc_runtime`

The bootstrap script automatically derives the PlanetScale branch suffix from
`TRAFFIC_CONTROL_ADMIN_DATABASE_URL` and writes the runtime secret using a
branch-qualified username like `yaffle_tc_runtime.main`.

## Deploy Notes

The Lambda resources intentionally use a placeholder zip during early scaffolding.
Code deployment should later be handled by a dedicated build/deploy step once the
 handlers do real work.

## Least-Privilege Note

The runtime boundary is now versioned in repo through a privileged SQL bootstrap,
but it still depends on an admin connection being available during setup and
future privilege changes.

The current model is:

- Terraform creates the secret shell and Lambda IAM
- privileged bootstrap SQL creates/updates `yaffle_tc_runtime`
- bootstrap updates the runtime DB URL secret
- Lambdas read only that runtime secret
