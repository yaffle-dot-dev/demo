# System Setup

One-time system dependencies for Yaffle development.

## Requirements

- **macOS 26 (Tahoe)** or later
- **Apple Silicon** (M1/M2/M3/M4)

## Container Runtime

Yaffle uses [Apple container](https://github.com/apple/container) for running
OCI containers locally. This is a system-level dependency.

### Install

1. Download the latest `.pkg` from [GitHub Releases](https://github.com/apple/container/releases)
2. Double-click to install
3. Start the service:

```bash
container system start
```

### Verify

```bash
container system status
container run --rm alpine echo "hello from container"
```

## Caddy Local CA

On first run, Caddy needs to install its local CA certificate for HTTPS:

```bash
caddy trust
```

This requires sudo and adds the CA to your system keychain.

## 1Password Environments (.env destination)

Yaffle local development expects secrets via a mounted `.env` file from
1Password Environments.

1. In 1Password desktop app, enable the Developer experience.
2. Create/open your Yaffle environment.
3. Add a Local `.env` destination mounted at `env/dev/secrets.1password.env`.
4. Populate variables in `env/dev/secrets.1password.env`.
5. Keep 1Password unlocked while running local dev services.

No extra wrapper is required for local dev once the mounted file is configured.

## Nix

This project uses [Determinate Nix](https://determinate.systems/nix/) with
FlakeHub cache. If you don't have Nix installed:

```bash
curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh -s -- install
```
