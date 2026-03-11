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
    exec nix run github:cachix/devenv/v2.0.3 -- "$@"
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
  # Non-secret env vars shared across all processes.
  # Secrets are injected per-process via processes.<name>.env using
  # config.secretspec.secrets (see control-plane process below).
  env = {
    # Use opentofu as the terraform binary
    YAFFLE_AUTH_MODE = "required";
    YAFFLE_TF_BINARY = "${pkgs.opentofu}/bin/tofu";
    YAFFLE_STATE_BUCKET = "yaffle-state-main-use1";
    # YAFFLE_TFC_DEBUG = "1";
    # YAFFLE_TF_DEBUG = "1";

    # Smee webhook proxy for local GitHub App development
    SMEE_URL = "https://smee.io/AMHdVEIzSjKsXVkb";

    # Auth defaults (OpenAuth - mounted at root, not /auth)
    YAFFLE_AUTH_ISSUER = "https://yaffle.local:6969";
    YAFFLE_AUTH_CLIENT_ID = "yaffle-web";
    VITE_YAFFLE_AUTH_ISSUER = "https://yaffle.local:6969";
    VITE_YAFFLE_AUTH_CLIENT_ID = "yaffle-web";

    # TFC backend (use local Caddy HTTPS endpoint)
    YAFFLE_TFC_API_HOST = "yaffle.local:6969";

    # BetterAuth config for Caddy proxy
    BETTER_AUTH_URL = "https://yaffle.local:6969";
    TRUSTED_ORIGINS = "https://yaffle.local:6969,https://yaffle.local:6969,http://yaffle.local:5173,http://yaffle.local:3000";

    # Telemetry defaults for local dev (disabled, no endpoint)
    YAFFLE_ENV = "development";

    # Debug TFC backend issues - set to TRACE for very verbose output
    # Uncomment to enable: YAFFLE_TF_DEBUG = "1";
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

    # Log to file for easier debugging
    settings = {
      logging_collector = "on";
      log_directory = "${config.devenv.root}/.devenv/logs";
      log_filename = "postgres.log";
      log_statement = "all";  # Log all statements (useful for debugging)
      log_min_messages = "info";
    };
  };

  # ── Process management (devenv up) ──────────────────────────────
  # devenv 2.0 uses native process manager
  process.manager.implementation = "native";

  # Create logs directory before starting processes
  process.manager.before = ''
    mkdir -p .devenv/logs
    echo "Logs will be written to .devenv/logs/"
  '';

  processes = {
    # Caddy reverse proxy - provides HTTPS on yaffle.local:6969
    # First run: `caddy trust` to install the local CA
    caddy = {
      exec = "caddy run --config Caddyfile 2>&1 | tee -a .devenv/logs/caddy.log";
      ready = {
        http.get = { port = 6969; path = "/api/health"; scheme = "https"; };
        period = 10;
        failure_threshold = 5;
      };
    };

    control-plane = {
      exec = "bun run dev:control-plane 2>&1 | tee -a .devenv/logs/control-plane.log";
      # Secrets injected via secretspec integration (only this process needs them)
      env = {
        DATABASE_URL = config.secretspec.secrets.DATABASE_URL or "";
        GITHUB_APP_ID = config.secretspec.secrets.GITHUB_APP_ID or "";
        GITHUB_APP_PRIVATE_KEY = config.secretspec.secrets.GITHUB_APP_PRIVATE_KEY or "";
        GITHUB_WEBHOOK_SECRET = config.secretspec.secrets.GITHUB_WEBHOOK_SECRET or "";
        GITHUB_OAUTH_CLIENT_ID = config.secretspec.secrets.GITHUB_OAUTH_CLIENT_ID or "";
        GITHUB_OAUTH_CLIENT_SECRET = config.secretspec.secrets.GITHUB_OAUTH_CLIENT_SECRET or "";
        CLOUDFLARE_API_TOKEN = config.secretspec.secrets.CLOUDFLARE_API_TOKEN or "";
        AWS_ACCESS_KEY_ID = config.secretspec.secrets.AWS_ACCESS_KEY_ID or "";
        AWS_SECRET_ACCESS_KEY = config.secretspec.secrets.AWS_SECRET_ACCESS_KEY or "";
        AWS_ACCOUNT_ID = config.secretspec.secrets.AWS_ACCOUNT_ID or "";
        AWS_REGION = config.secretspec.secrets.AWS_REGION or "us-east-1";
        OTEL_EXPORTER_OTLP_ENDPOINT = config.secretspec.secrets.OTEL_EXPORTER_OTLP_ENDPOINT or "";
        OTEL_EXPORTER_OTLP_HEADERS = config.secretspec.secrets.OTEL_EXPORTER_OTLP_HEADERS or "";
        BETTER_AUTH_SECRET = config.secretspec.secrets.BETTER_AUTH_SECRET or "";
      };
      ready = {
        http.get = { port = 3000; path = "/api/health"; };
        period = 10;
        failure_threshold = 3;
      };
    };

    web = {
      exec = "bun run dev:web 2>&1 | tee -a .devenv/logs/web.log";
      ready = {
        http.get = { port = 5173; path = "/"; };
        period = 10;
        failure_threshold = 3;
      };
    };

    marketing = {
      exec = "bun run --filter=@yaffle/marketing dev 2>&1 | tee -a .devenv/logs/marketing.log";
      ready = {
        http.get = { port = 4000; path = "/"; };
        period = 10;
        failure_threshold = 3;
      };
    };

    smee = {
      exec = "npx smee-client --url $SMEE_URL --target http://yaffle.local:6969/api/webhooks/github 2>&1 | tee -a .devenv/logs/smee.log";
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
  # Build: devenv container build control-plane -s x86_64-linux
  # Push:  devenv container --registry docker://ghcr.io/yaffle-dot-dev/yaffle/ copy control-plane
  #
  # Environment variables (PORT, NODE_ENV, DATABASE_URL, etc.) should be set
  # at runtime when deploying the container. The app defaults PORT to 3000.
  containers."control-plane" = {
    name = "control-plane";

    # Run the built application
    startupCommand = "${controlPlane}/bin/yaffle-control-plane";

    # Copy CA certs for HTTPS connections to external services
    copyToRoot = pkgs.buildEnv {
      name = "control-plane-root";
      paths = [ pkgs.cacert ];
      pathsToLink = [ "/etc/ssl" ];
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
    echo "secrets: auto-injected to control-plane via devenv secretspec (1password/development)"
    echo ""
    echo "commands:"
    echo "  devenv up              - start caddy, postgres, control-plane, web, and smee"
    echo "                           (secrets auto-injected to control-plane only)"
    echo "  tofu login yaffle.local:6969 - authenticate with Yaffle TFC backend"
    echo "  bun install            - install dependencies"
    echo "  bun test               - run tests"
    echo "  tofu plan              - run opentofu plan (from infra/)"
    echo "  secretspec check       - verify all secrets are configured"
    echo "  secretspec config init - set up 1Password provider"
    echo "  op signin"
    echo ""
    echo "logs (when devenv up is running):"
    echo "  tail -f .devenv/logs/control-plane.log"
    echo "  tail -f .devenv/logs/web.log"
    echo "  tail -f .devenv/logs/caddy.log"
    echo "  tail -f .devenv/logs/postgres.log"
    echo ""
    echo "endpoints (after devenv up):"
    echo "  https://yaffle.local:6969       - marketing site"
    echo "  https://yaffle.local:6969/app   - web app"
    echo "  https://yaffle.local:6969/api   - control plane API"
    echo "  https://yaffle.local:6969/tfc   - TFC-compatible state backend"
    echo ""
  '';
}
