{
  description = "Yaffle - Terraform runner with ephemeral preview workspaces";

  inputs = {
    nixpkgs.url = "github:cachix/devenv-nixpkgs/rolling";
    systems.url = "github:nix-systems/default";
    # Latest devenv 2.x (may have cached binaries)
    devenv.url = "github:cachix/devenv";
  };

  nixConfig = {
    extra-trusted-public-keys = "devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=";
    extra-substituters = "https://devenv.cachix.org";
  };

  outputs = { self, nixpkgs, devenv, systems, ... }:
    let
      forEachSystem = nixpkgs.lib.genAttrs (import systems);
    in {
      devShells = forEachSystem (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          devenv-cli = devenv.packages.${system}.devenv;
        in {
          default = pkgs.mkShell {
            packages = with pkgs; [
              # devenv 2.x CLI
              devenv-cli

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
            ];

            shellHook = ''
              echo ""
              echo "yaffle dev environment"
              echo "  devenv      $(devenv version 2>&1 | head -1)"
              echo "  bun         $(bun --version)"
              echo "  tofu        $(tofu --version | head -1)"
              echo "  psql        $(psql --version)"
              echo "  jj          $(jj --version)"
              echo "  secretspec  $(secretspec --version)"
              echo "  op          $(op --version)"
              echo ""
              echo "commands:"
              echo "  devenv up              - start postgres, control-plane, web, and smee"
              echo "  bun install            - install dependencies"
              echo "  bun test               - run tests"
              echo "  tofu plan              - run opentofu plan (from infra/)"
              echo ""
            '';

            YAFFLE_TF_BINARY = "${pkgs.opentofu}/bin/tofu";
            SMEE_URL = "https://smee.io/AMHdVEIzSjKsXVkb";
            SECRETSPEC_PROFILE = "development";
            SECRETSPEC_PROVIDER = "onepassword://yaffle.dev";
            YAFFLE_AUTH_MODE = "required";
            YAFFLE_AUTH_ISSUER = "http://localhost:3000";
            YAFFLE_AUTH_CLIENT_ID = "yaffle-web";
            VITE_YAFFLE_AUTH_ISSUER = "http://localhost:3000";
            VITE_YAFFLE_AUTH_CLIENT_ID = "yaffle-web";
            YAFFLE_ENV = "development";
          };
        }
      );
    };
}
