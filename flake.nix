{
  description = "Yaffle - Terraform runner with ephemeral preview workspaces";

  inputs = {
    nixpkgs.url = "github:cachix/devenv-nixpkgs/rolling";
    systems.url = "github:nix-systems/default";
    # Latest devenv 2.x (may have cached binaries)
    devenv.url = "github:cachix/devenv";
    # nix2container for building OCI images
    nix2container.url = "github:nlewo/nix2container";
    nix2container.inputs.nixpkgs.follows = "nixpkgs";
  };

  nixConfig = {
    extra-trusted-public-keys = "devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=";
    extra-substituters = "https://devenv.cachix.org";
  };

  outputs = { self, nixpkgs, devenv, systems, nix2container, ... }:
    let
      forEachSystem = nixpkgs.lib.genAttrs (import systems);
    in {
      # Packages - these get cached by FlakeHub Cache
      packages = forEachSystem (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          n2c = nix2container.packages.${system}.nix2container;

          # Control-plane application
          control-plane = pkgs.callPackage ./nix/control-plane.nix {
            inherit pkgs;
            lib = pkgs.lib;
            src = ./.;
          };

          # OCI container image for control-plane
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
              exposedPorts = {
                "3000/tcp" = {};
              };
            };

            # Copy CA certs for HTTPS
            copyToRoot = pkgs.buildEnv {
              name = "root";
              paths = [ pkgs.cacert ];
              pathsToLink = [ "/etc/ssl" ];
            };
          };
        in {
          inherit control-plane;
          control-plane-image = control-plane-image;
          default = control-plane;
        }
      );

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
