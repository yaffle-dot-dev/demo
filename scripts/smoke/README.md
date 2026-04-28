# Local-First Smoke Harness

The local-first smoke harness exercises the cross-process path for:

- Rust `yaffle` CLI
- local control-plane process
- isolated Postgres container
- anonymous session bootstrap
- hosted output-module publish/read
- raw `tofu` fallback via `yaffle tf login`

Run it with:

```bash
bun run smoke:local-first
```

## Runtime requirements

This harness uses `testcontainers` and needs a working OCI runtime API.

Examples:

- Docker Desktop / Docker Engine
- Podman with a running machine and Docker-compatible socket/API

If you are using Podman, make sure the machine is started first. The harness
tries to auto-detect the `podman-machine-default` socket and set `DOCKER_HOST`
for `testcontainers`.

The harness also expects a working local `caddy` install, because it exercises
the same HTTPS module-registry/discovery transport shape that local-first
Yaffle uses.

If your machine has never trusted Caddy's local CA before, you may need a
one-time trust step outside the harness:

```bash
caddy trust
```

The harness:

- starts a fresh Postgres container
- migrates the control-plane schema into that isolated database
- starts the control-plane process on a random local port
- copies a fixture repo to a temp directory
- runs `yaffle converge`
- verifies `yaffle outputs`
- verifies raw `tofu` fallback using:

```bash
eval "$(yaffle tf login --env main --workspace apps/web/infra)"
```

It does not rely on any shared local dev database or pre-running services.

Current smoke scope for raw `tofu` fallback verifies module/discovery auth with
plain `tofu init`. Local state/backend helper behavior for fully raw `tofu`
stateful commands can be extended later if we decide to add more shell-side
bootstrap beyond `yaffle tf login`.
