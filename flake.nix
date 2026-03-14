{
  description = "Yaffle - Terraform runner with ephemeral preview workspaces";

  inputs = {
    nixpkgs.url = "github:cachix/devenv-nixpkgs/rolling";
    systems.url = "github:nix-systems/default";
    nix2container.url = "github:nlewo/nix2container";
    nix2container.inputs.nixpkgs.follows = "nixpkgs";
  };

  nixConfig = {
    extra-trusted-public-keys = "devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=";
    extra-substituters = "https://devenv.cachix.org";
  };

  outputs = { self, nixpkgs, systems, nix2container, ... }:
    let
      forEachSystem = nixpkgs.lib.genAttrs (import systems);
    in {
      packages = forEachSystem (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          n2c = nix2container.packages.${system}.nix2container;

          control-plane = pkgs.callPackage ./nix/control-plane.nix {
            inherit pkgs;
            lib = pkgs.lib;
            src = ./.;
          };

          yaffle-cli = pkgs.callPackage ./nix/yaffle-cli.nix {
            inherit pkgs;
            lib = pkgs.lib;
            src = ./.;
          };

          control-plane-image = n2c.buildImage {
            name = "ghcr.io/yaffle-dot-dev/yaffle/control-plane";
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
        in {
          inherit control-plane yaffle-cli;
          control-plane-image = control-plane-image;
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
          pkgs = nixpkgs.legacyPackages.${system};
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

              # Secrets
              secretspec
              _1password-cli

              # Version control / GitHub
              jujutsu
              gh

              # Dev tooling
              opencode
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
              echo "  process-compose  $(process-compose --version)"
              echo ""
              echo "commands:"
              echo "  ./scripts/dev-init.sh      - first-time setup (postgres init)"
              echo "  process-compose up         - start all services"
              echo "  process-compose up -t=false - start without TUI"
              echo "  process-compose down       - stop all services"
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

            # Environment variables
            YAFFLE_TF_BINARY = "${pkgs.opentofu}/bin/tofu";
            YAFFLE_STATE_BUCKET = "yaffle-state-main-use1";
            SMEE_URL = "https://smee.io/AMHdVEIzSjKsXVkb";
            YAFFLE_AUTH_MODE = "required";
            YAFFLE_AUTH_ISSUER = "https://yaffle.local:6969";
            YAFFLE_AUTH_CLIENT_ID = "yaffle-web";
            VITE_YAFFLE_AUTH_ISSUER = "https://yaffle.local:6969";
            VITE_YAFFLE_AUTH_CLIENT_ID = "yaffle-web";
            YAFFLE_TFC_API_HOST = "yaffle.local:6969";
            YAFFLE_CONTROL_PLANE_ROLE_ARN = "arn:aws:iam::870923192739:root";
            BETTER_AUTH_URL = "https://yaffle.local:6969";
            TRUSTED_ORIGINS = "https://yaffle.local:6969,http://yaffle.local:5173,http://yaffle.local:3000";
            YAFFLE_ENV = "development";
          };
        }
      );
    };
}
