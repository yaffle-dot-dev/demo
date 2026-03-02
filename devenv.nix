{ pkgs, ... }:

{
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
  processes = {
    api.exec = "op whoami >/dev/null 2>&1 || op signin; secretspec run -- bun run dev:api";
    web.exec = "bun run dev:web";
    smee.exec = "npx smee-client --url $SMEE_URL --target http://localhost:3000/api/webhooks/github";
  };

  # ── Process health checks ────────────────────────────────────
  process-managers.process-compose.settings.processes = {
    api = {
      readiness_probe = {
        http_get = {
          host = "localhost";
          port = 3000;
          path = "/api/health";
          scheme = "http";
        };
        initial_delay_seconds = 2;
        period_seconds = 10;
        timeout_seconds = 2;
        success_threshold = 1;
        failure_threshold = 3;
      };
    };

    web = {
      readiness_probe = {
        http_get = {
          host = "localhost";
          port = 5173;
          path = "/";
          scheme = "http";
        };
        initial_delay_seconds = 10;
        period_seconds = 10;
        timeout_seconds = 2;
        success_threshold = 1;
        failure_threshold = 3;
      };
    };

    smee = {
      readiness_probe = {
        exec = {
          command = "pgrep -f smee-client";
        };
        initial_delay_seconds = 2;
        period_seconds = 10;
        timeout_seconds = 1;
        success_threshold = 1;
        failure_threshold = 3;
      };
    };
  };

  # ── Shell hook ───────────────────────────────────────────────────
  enterShell = ''
    echo ""
    echo "yaffle dev environment"
    echo "  bun         $(bun --version)"
    echo "  tofu        $(tofu --version | head -1)"
    echo "  psql        $(psql --version)"
    echo "  jj          $(jj --version)"
    echo "  secretspec  $(secretspec --version)"
    echo "  op          $(op --version)"
    echo ""
    echo "commands:"
    echo "  devenv up              - start postgres, api, and web"
    echo "  bun install            - install dependencies"
    echo "  bun test               - run tests"
    echo "  tofu plan              - run opentofu plan (from infra/)"
    echo "  secretspec check       - verify all secrets are configured"
    echo "  secretspec config init - set up 1Password provider"
    echo "  secretspec run -- cmd  - run cmd with secrets injected"
    echo "  op signin"
    echo ""
  '';

  # ── Git hooks ────────────────────────────────────────────────────
  git-hooks.hooks = {
    check-merge-conflicts.enable = true;
    end-of-file-fixer.enable = true;
    trim-trailing-whitespace.enable = true;
  };
}
