{ pkgs, lib, config, ... }:

let
  # Build the control-plane application
  controlPlane = pkgs.callPackage ./nix/control-plane.nix {
    inherit pkgs lib;
    src = ./.;
  };
in
{
  # Override devenv to use 2.x CLI via nix run (avoids rebuilds)
  scripts.devenv.exec = ''
    exec nix run github:cachix/devenv/v2.0.1 -- "$@"
  '';

  # ── Core tools ───────────────────────────────────────────────────
  packages = with pkgs; [
    # JavaScript / TypeScript
    bun
    nodejs_22    # SvelteKit adapter-node, some tooling expects node

    # Infrastructure
    opentofu     # Terraform CLI (open-source fork)
    awscli2

    # Database
    postgresql_17  # CLI tools (psql, pg_dump, etc.)

    # Secrets
    secretspec
    _1password-cli  # `op` CLI for 1Password provider

    # Version control / GitHub
    jujutsu
    gh

    # Dev tooling
    opencode

    # Local HTTPS reverse proxy
    caddy
  ];

  # ── Environment variables ────────────────────────────────────────
  env = {
    # Use opentofu as the terraform binary
    YAFFLE_TF_BINARY = "${pkgs.opentofu}/bin/tofu";

    # Smee webhook proxy for local GitHub App development
    SMEE_URL = "https://smee.io/AMHdVEIzSjKsXVkb";

    # Secretspec defaults for local dev
    SECRETSPEC_PROFILE = "development";
    SECRETSPEC_PROVIDER = "onepassword://yaffle.dev";

    # Auth defaults (OpenAuth - mounted at root, not /auth)
    YAFFLE_AUTH_MODE = "required";
    YAFFLE_AUTH_ISSUER = "https://localhost:6969";
    YAFFLE_AUTH_CLIENT_ID = "yaffle-web";
    VITE_YAFFLE_AUTH_ISSUER = "https://localhost:6969";
    VITE_YAFFLE_AUTH_CLIENT_ID = "yaffle-web";

    # TFC backend (use local Caddy HTTPS endpoint)
    YAFFLE_TFC_API_HOST = "localhost:6969";

    # BetterAuth config for Caddy proxy
    BETTER_AUTH_URL = "https://localhost:6969";
    TRUSTED_ORIGINS = "https://localhost:6969,http://localhost:5173,http://localhost:3000";

    # Telemetry defaults for local dev (disabled, no endpoint)
    YAFFLE_ENV = "development";
  };

  # ── Postgres ─────────────────────────────────────────────────────
  services.postgres = {
    enable = true;
    package = pkgs.postgresql_17;
    listen_addresses = "127.0.0.1";
    port = 5432;

    initialDatabases = [
      { name = "yaffle_dev"; }
      { name = "yaffle_test"; }
    ];

    initialScript = ''
      CREATE USER yaffle WITH SUPERUSER;
      GRANT ALL PRIVILEGES ON DATABASE yaffle_dev TO yaffle;
      GRANT ALL PRIVILEGES ON DATABASE yaffle_test TO yaffle;
    '';
  };

  # ── Process management (devenv up) ──────────────────────────────
  # devenv 2.0 uses native process manager
  process.manager.implementation = "native";

  processes = {
    # Caddy reverse proxy - provides HTTPS on localhost:6969
    # First run: `caddy trust` to install the local CA
    caddy = {
      exec = "caddy run --config Caddyfile";
      ready = {
        http.get = { port = 6969; path = "/api/health"; scheme = "https"; };
        period = 10;
        failure_threshold = 5;
      };
    };

    control-plane = {
      exec = "op whoami >/dev/null 2>&1 || op signin; secretspec run -- bun run dev:control-plane";
      ready = {
        http.get = { port = 3000; path = "/api/health"; };
        period = 10;
        failure_threshold = 3;
      };
    };

    web = {
      exec = "bun run dev:web";
      ready = {
        http.get = { port = 5173; path = "/"; };
        period = 10;
        failure_threshold = 3;
      };
    };

    smee = {
      exec = "npx smee-client --url $SMEE_URL --target http://localhost:3000/api/webhooks/github";
      ready = {
        exec = "pgrep -f smee-client";
        period = 10;
        failure_threshold = 3;
      };
    };
  };

  # ── Containers ───────────────────────────────────────────────────
  # Test container to verify devenv + Determinate Nix Linux builder works
  containers."hello-test" = {
    name = "yaffle-hello-test";
    startupCommand = "${pkgs.hello}/bin/hello";
  };

  # Control-plane API container
  # Build: devenv container build control-plane -s aarch64-linux
  # Push:  devenv container --registry docker://ghcr.io/yaffle-dev/ copy control-plane
  containers."control-plane" = {
    name = "yaffle-control-plane";

    # Run the built application
    startupCommand = "${controlPlane}/bin/yaffle-control-plane";

    # Copy CA certs for HTTPS connections to external services
    copyToRoot = pkgs.buildEnv {
      name = "control-plane-root";
      paths = [ pkgs.cacert ];
      pathsToLink = [ "/etc/ssl" ];
    };

    # OCI image configuration
    config = {
      Env = [
        "PORT=3000"
        "NODE_ENV=production"
        "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
      ];
      ExposedPorts = {
        "3000/tcp" = {};
      };
    };
  };

  # ── Shell hook ───────────────────────────────────────────────────
  enterShell = ''
    # Install Caddy's local CA if not already trusted
    if ! security find-certificate -c "Caddy Local Authority" /Library/Keychains/System.keychain &>/dev/null; then
      echo "Installing Caddy's local CA (requires sudo)..."
      caddy trust 2>/dev/null || echo "  Run 'caddy trust' manually if needed"
    fi

    echo ""
    echo "yaffle dev environment"
    echo "  bun         $(bun --version)"
    echo "  tofu        $(tofu --version | head -1)"
    echo "  psql        $(psql --version)"
    echo "  jj          $(jj --version)"
    echo "  secretspec  $(secretspec --version)"
    echo "  op          $(op --version)"
    echo "  caddy       $(caddy version)"
    echo ""
    echo "commands:"
    echo "  devenv up              - start caddy, postgres, control-plane, web, and smee"
    echo "  tofu login localhost:6969 - authenticate with Yaffle TFC backend"
    echo "  bun install            - install dependencies"
    echo "  bun test               - run tests"
    echo "  tofu plan              - run opentofu plan (from infra/)"
    echo "  secretspec check       - verify all secrets are configured"
    echo "  secretspec config init - set up 1Password provider"
    echo "  secretspec run -- cmd  - run cmd with secrets injected"
    echo "  op signin"
    echo ""
    echo "endpoints (after devenv up):"
    echo "  https://localhost:6969/api   - control plane API"
    echo "  https://localhost:6969/tfc   - TFC-compatible state backend"
    echo "  https://localhost:6969/app   - web app"
    echo ""
  '';
}
