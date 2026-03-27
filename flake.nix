{
  description = "Yaffle - Terraform runner with ephemeral preview workspaces";

  inputs = {
    nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/0.1";
    systems.url = "github:nix-systems/default";
    nix2container.url = "github:nlewo/nix2container";
    nix2container.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, systems, nix2container, ... }:
    let
      forEachSystem = nixpkgs.lib.genAttrs (import systems);
    in {
      packages = forEachSystem (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          n2c = nix2container.packages.${system}.nix2container;

          # Control-plane requires a pre-built JS bundle
          # In CI: bun install && bun build, then nix packages it
          # Pass bundlePath via --arg or use the wrapper script
          control-plane = pkgs.callPackage ./nix/control-plane.nix {
            inherit pkgs;
            lib = pkgs.lib;
            # bundlePath passed via --arg in CI, or use build-control-plane.sh locally
          };

          yaffle-cli = pkgs.callPackage ./nix/yaffle-cli.nix {
            inherit pkgs;
            lib = pkgs.lib;
            src = ./.;
          };

          runner = pkgs.callPackage ./nix/runner.nix {
            inherit pkgs;
            lib = pkgs.lib;
          };

          web = pkgs.callPackage ./nix/web.nix {
            inherit pkgs;
            lib = pkgs.lib;
          };

          control-plane-image = n2c.buildImage {
            name = "yaffle-control-plane";
            tag = "latest";
            config = {
              entrypoint = [ "${control-plane}/bin/yaffle-control-plane" ];
              env = [
                "PORT=3000"
                "NODE_ENV=production"
                "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
              ];
              exposedPorts = { "3000/tcp" = {}; };
            };
            copyToRoot = pkgs.buildEnv {
              name = "root";
              paths = [ pkgs.cacert ];
              pathsToLink = [ "/etc/ssl" ];
            };
          };

          # Web app image - SvelteKit SSR application
          web-image = n2c.buildImage {
            name = "yaffle-web";
            tag = "latest";
            config = {
              entrypoint = [ "${web}/bin/yaffle-web" ];
              env = [
                "PORT=3000"
                "NODE_ENV=production"
                "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
              ];
              exposedPorts = { "3000/tcp" = {}; };
            };
            copyToRoot = pkgs.buildEnv {
              name = "root";
              paths = [ pkgs.cacert ];
              pathsToLink = [ "/etc/ssl" ];
            };
          };

          # Runner image - minimal container for isolated tofu execution
          # Contains OpenTofu, Bun, and the TypeScript worker runtime.
          # NO access to Yaffle internals - all inputs flow through the Runner API.
          runner-image = n2c.buildImage {
            name = "yaffle-runner";
            tag = "latest";
            config = {
              entrypoint = [ "${pkgs.bun}/bin/bun" "${runner}/app/src/worker.ts" ];
              workingDir = "/workspace";
              env = [
                "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
                "HOME=/tmp"
              ];
            };
            copyToRoot = pkgs.buildEnv {
              name = "root";
              paths = [
                pkgs.cacert
                pkgs.opentofu
                pkgs.awscli2
                pkgs.curl
                pkgs.jq
                pkgs.gnutar
                pkgs.gzip
                pkgs.bash
                pkgs.coreutils
                pkgs.bun
                runner
              ];
              pathsToLink = [ "/bin" "/etc/ssl" "/app" ];
            };
          };
        in {
          inherit control-plane yaffle-cli runner web;
          control-plane-image = control-plane-image;
          web-image = web-image;
          runner-image = runner-image;
          default = control-plane;
          yaffle-outputs = yaffle-cli;
        }
      );

      apps = forEachSystem (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          yaffle-cli = self.packages.${system}.yaffle-cli;
        in {
          yaffle-outputs = {
            type = "app";
            program = "${yaffle-cli}/bin/yaffle-outputs";
          };
          yaffle = {
            type = "app";
            program = toString (pkgs.writeShellScript "yaffle" ''
              if [ ! -f "packages/cli/src/main.ts" ]; then
                echo "Error: Must run from yaffle repo root" >&2
                exit 1
              fi
              exec ${pkgs.bun}/bin/bun run packages/cli/src/main.ts "$@"
            '');
          };
          deploy-marketing = {
            type = "app";
            program = toString (pkgs.writeShellScript "deploy-marketing" ''
              if [ ! -f "scripts/deploy-marketing.ts" ]; then
                echo "Error: Must run from yaffle repo root" >&2
                exit 1
              fi
              exec ${pkgs.bun}/bin/bun run scripts/deploy-marketing.ts "$@"
            '');
          };
        }
      );

      devShells = forEachSystem (system:
        let
          pkgs = import nixpkgs {
            inherit system;
            config.allowUnfree = true;
          };
          dotenvx = pkgs.buildNpmPackage rec {
            pname = "dotenvx";
            version = "1.51.2";

            src = pkgs.fetchFromGitHub {
              owner = "dotenvx";
              repo = "dotenvx";
              tag = "v${version}";
              hash = "sha256-WafhFmph85r377VOFJBjXU8T/GbIrgXQ2RzcVb7GETw=";
            };

            npmDepsHash = "sha256-YVODU+0e9T/x9RkAEiHdQ1JxFlgwsrdyzx0ZIgmy9Fw=";
            dontNpmBuild = true;
          };
          depot = pkgs.stdenv.mkDerivation rec {
            pname = "depot";
            version = "2.101.29";

            src = pkgs.fetchurl {
              url = "https://github.com/depot/cli/releases/download/v${version}/depot_${version}_${
                if pkgs.stdenv.hostPlatform.isDarwin then "darwin" else "linux"
              }_${
                if pkgs.stdenv.hostPlatform.isAarch64 then "arm64" else "amd64"
              }.tar.gz";
              sha256 = if pkgs.stdenv.hostPlatform.isDarwin && pkgs.stdenv.hostPlatform.isAarch64
                then "sha256-YYBAhRD3Wa/pX/wEuB5vWwzv/A9FTFC7q0QTFxrh2lg="
                else if pkgs.stdenv.hostPlatform.isDarwin
                then "sha256-awqsc9mniAmg8OjujyKN9jNTn99kWe1D8iRgLq0IViA="
                else if pkgs.stdenv.hostPlatform.isAarch64
                then "sha256-FiSAs+mi1YqYQB4Ho3m9r6PZk3YWh4aH+hmNV0H2VEQ="
                else "sha256-o5eAlh/EQ9tUSE/LM0GnQtU8nkg4vsz/kYEOnkq/W4E=";
            };

            sourceRoot = ".";
            dontBuild = true;

            nativeBuildInputs = [ pkgs.installShellFiles ];

            installPhase = ''
              install -Dm755 bin/depot $out/bin/depot
            '';
          };
        in {
          default = pkgs.mkShell {
            packages = with pkgs; [
              # JavaScript / TypeScript
              bun
              nodejs_22

              # Infrastructure
              opentofu
              awscli2

              # Database
              postgresql_17
              pscale

              # Secrets
              secretspec
              _1password-cli

              # Version control / GitHub
              jujutsu
              gh

              # CI / Build
              depot

              # Dev tooling
              opencode
              claude-code
              dotenvx
              caddy
              process-compose
              watchexec
            ];

            shellHook = ''
              # Postgres data directory
              export PGDATA="$PWD/.dev/postgres"
              export PGHOST="/tmp"

              # Trust Caddy's local CA for HTTPS in development
              export NODE_EXTRA_CA_CERTS="$HOME/Library/Application Support/Caddy/pki/authorities/local/root.crt"

              # Check Caddy CA trust
              if ! security find-certificate -c "Caddy Local Authority" /Library/Keychains/System.keychain &>/dev/null 2>&1; then
                echo "Note: Run 'caddy trust' to install local HTTPS CA"
              fi

              # Create logs directory
              mkdir -p .dev/logs

              echo ""
              echo "yaffle dev environment"
              echo "  bun              $(bun --version)"
              echo "  tofu             $(tofu --version | head -1)"
              echo "  psql             $(psql --version)"
              echo "  jj               $(jj --version)"
              echo "  secretspec       $(secretspec --version)"
              echo "  process-compose  $(process-compose version | head -1)"
              echo ""
               echo "commands:"
                echo "  ./scripts/dev-init.sh      - first-time setup (postgres init)"
                echo "  process-compose up         - start all services"
                echo "  process-compose up -t=false - start without TUI"
                echo "  process-compose down       - stop all services"
                echo "  YAFFLE_DEV_RUNNER_MODE=ecs process-compose up -t=false - restart CP in ECS mode"
                echo "  bun install                - install dependencies"
                echo "  bun test                   - run tests"
              echo ""
              echo "logs:"
              echo "  tail -f .dev/logs/control-plane.log"
              echo "  tail -f .dev/logs/web.log"
              echo "  tail -f .dev/logs/postgres.log"
              echo ""
              echo "endpoints (after process-compose up):"
              echo "  https://yaffle.local:6969       - marketing site"
              echo "  https://yaffle.local:6969/app   - web app"
              echo "  https://yaffle.local:6969/api   - control plane API"
              echo ""
            '';

            # Stable shell defaults. Runtime app config is loaded from env/dev/*.env.
            YAFFLE_DEV_RUNNER_MODE = "local";
          };
        }
      );
    };
}
