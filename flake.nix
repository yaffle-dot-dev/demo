{
  description = "Yaffle - Terraform runner with ephemeral preview workspaces";

  inputs = {
    nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/0.1";
    systems.url = "github:nix-systems/default";
  };

  outputs = { self, nixpkgs, systems, ... }:
    let
      forEachSystem = nixpkgs.lib.genAttrs (import systems);
    in {
      packages = forEachSystem (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          lib = pkgs.lib;
          repoRoot = ./.;
          repoRootString = toString repoRoot;

          bunBaseEnv = [
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bun-node-fallback-bin"
            "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0"
            "BUN_INSTALL_BIN=/usr/local/bin"
          ];

          repoSrc = lib.cleanSourceWith {
            src = repoRoot;
            name = "yaffle-image-src";
            filter = path: type:
              let
                pathString = toString path;
                relativePath = if pathString == repoRootString
                  then ""
                  else lib.removePrefix (repoRootString + "/") pathString;
                baseName = baseNameOf path;
              in
              !(
                baseName == ".git" ||
                baseName == ".jj" ||
                baseName == "node_modules" ||
                baseName == "dist" ||
                baseName == "target" ||
                baseName == ".dev" ||
                baseName == ".direnv" ||
                baseName == ".terraform" ||
                baseName == "infra_modules" ||
                baseName == "backups" ||
                baseName == "result" ||
                baseName == ".astro" ||
                baseName == ".opencode" ||
                baseName == ".agents" ||
                baseName == ".claude" ||
                baseName == ".depot" ||
                baseName == "tmp" ||
                baseName == ".DS_Store" ||
                lib.hasPrefix "infra/" relativePath ||
                relativePath == "infra" ||
                lib.hasPrefix "apps/control-plane/infra/" relativePath ||
                relativePath == "apps/control-plane/infra" ||
                lib.hasPrefix "apps/web/infra/" relativePath ||
                relativePath == "apps/web/infra" ||
                lib.hasPrefix "apps/runner/infra/" relativePath ||
                relativePath == "apps/runner/infra" ||
                lib.hasPrefix "apps/infra/" relativePath ||
                relativePath == "apps/infra" ||
                lib.hasPrefix ".terraform/" relativePath ||
                relativePath == ".terraform" ||
                lib.hasSuffix "/.terraform" relativePath ||
                lib.hasInfix "/.terraform/" relativePath ||
                lib.hasPrefix "actions/" relativePath ||
                lib.hasPrefix "crates/" relativePath ||
                lib.hasPrefix "plans/" relativePath
              );
          };

          workspaceManifestPaths = [
            "apps/control-plane/package.json"
            "apps/docs/package.json"
            "apps/marketing/package.json"
            "apps/provider-discovery-agent/package.json"
            "apps/runner/package.json"
            "apps/traffic-controller/package.json"
            "apps/web/package.json"
            "packages/design/package.json"
            "packages/shared/package.json"
            "packages/yaffle-client/package.json"
          ];

          rootWorkspaceFiles = [
            "package.json"
            "bun.lock"
            "tsconfig.json"
            "bunfig.toml"
          ];

          extraManifests = excluded:
            builtins.filter (path: !(builtins.elem path excluded)) workspaceManifestPaths;

          mkSourceTree = name: copyPaths:
            pkgs.runCommand name { } ''
              mkdir -p "$out"
              ${lib.concatStringsSep "\n" (map (path: ''
                mkdir -p "$out/$(dirname "${path}")"
                cp -R "${repoSrc}/${path}" "$out/${path}"
              '') copyPaths)}
            '';

          mkBunWorkspaceBuild = {
            name,
            srcTree,
            installArgs,
            buildCommands,
            installCommands,
          }:
            pkgs.stdenv.mkDerivation {
              pname = name;
              version = "0.1.0";
              src = srcTree;

              nativeBuildInputs = [
                pkgs.bun
                pkgs.nodejs_22
                pkgs.cacert
              ];

              HOME = "/tmp";

              configurePhase = ''
                runHook preConfigure
                export BUN_INSTALL="$TMPDIR/.bun"
                export BUN_TMPDIR="$TMPDIR"
                mkdir -p "$BUN_INSTALL"
                bun install ${installArgs}
                runHook postConfigure
              '';

              buildPhase = ''
                runHook preBuild
                cd "$NIX_BUILD_TOP/$sourceRoot"
                ${buildCommands}
                runHook postBuild
              '';

              installPhase = ''
                runHook preInstall
                cd "$NIX_BUILD_TOP/$sourceRoot"
                ${installCommands}
                runHook postInstall
              '';
            };

          controlPlaneSource = mkSourceTree "control-plane-image-src" (
            rootWorkspaceFiles
            ++ extraManifests [
              "apps/control-plane/package.json"
              "packages/shared/package.json"
            ]
            ++ [
              "apps/control-plane"
              "packages/shared"
            ]
          );

          webSource = mkSourceTree "web-image-src" (
            rootWorkspaceFiles
            ++ extraManifests [
              "apps/web/package.json"
              "packages/design/package.json"
              "packages/shared/package.json"
            ]
            ++ [
              "apps/web"
              "packages/design"
              "packages/shared"
            ]
          );

          runnerSource = mkSourceTree "runner-image-src" (
            rootWorkspaceFiles
            ++ extraManifests [
              "apps/runner/package.json"
              "packages/shared/package.json"
            ]
            ++ [
              "apps/runner"
              "packages/shared"
            ]
          );

          controlPlaneBundle = mkBunWorkspaceBuild {
            name = "control-plane-bundle";
            srcTree = controlPlaneSource;
            installArgs = "--frozen-lockfile --production --filter=@yaffle/control-plane";
            buildCommands = ''
              mkdir -p bundle/node_modules
              NODE_ENV=production bun build apps/control-plane/src/index.ts \
                --outdir bundle \
                --target bun \
                --external minijinja-js
              cp -R node_modules/.bun/minijinja-js@*/node_modules/minijinja-js bundle/node_modules/
            '';
            installCommands = ''
              mkdir -p "$out"
              cp -R bundle/. "$out/"
            '';
          };

          webBundle = mkBunWorkspaceBuild {
            name = "web-bundle";
            srcTree = webSource;
            installArgs = "--frozen-lockfile --filter=@yaffle/web";
            buildCommands = ''
              cd apps/web
              bun run build
            '';
            installCommands = ''
              mkdir -p "$out"
              cp -R apps/web/build/. "$out/"
            '';
          };

          runnerAppRoot = mkBunWorkspaceBuild {
            name = "runner-app-root";
            srcTree = runnerSource;
            installArgs = "--frozen-lockfile --production --filter=@yaffle/runner";
            buildCommands = "true";
            installCommands = ''
              mkdir -p "$out/app/apps" "$out/app/packages"
              cp -R apps/runner "$out/app/apps/runner"
              cp -R packages/shared "$out/app/packages/shared"
              if [ -d node_modules ]; then
                cp -R node_modules "$out/app/node_modules"
              fi
              if [ -d apps/node_modules ]; then
                cp -R apps/node_modules "$out/app/apps/node_modules"
              fi
              mkdir -p "$out/app/apps/packages"
              ln -s ../../packages/shared "$out/app/apps/packages/shared"
            '';
          };

          tofuDeb = pkgs.fetchurl {
            url = "https://github.com/opentofu/opentofu/releases/download/v1.11.5/tofu_1.11.5_arm64.deb";
            hash = "sha256-9DkXqJ92po5ikTNGPAJ60l7L8xA3jkVgM7GDm9hB2PQ=";
          };

          tofuRoot = pkgs.runCommand "runner-tofu-root" {
            nativeBuildInputs = [
              pkgs.binutils
              pkgs.gnutar
            ];
          } ''
            mkdir -p "$out"
            cp "${tofuDeb}" tofu.deb
            ar x tofu.deb data.tar.gz
            tar -xzf data.tar.gz -C "$out"
          '';

          controlPlaneImageRoot = pkgs.runCommand "control-plane-image-root" { } ''
            mkdir -p "$out/app"
            cp -R "${controlPlaneBundle}"/. "$out/app/"
            cp -R "${pkgs.dockerTools.caCertificates}"/etc "$out/etc"
          '';

          webImageRoot = pkgs.runCommand "web-image-root" { } ''
            mkdir -p "$out/app"
            cp -R "${webBundle}"/. "$out/app/"
            cp -R "${pkgs.dockerTools.caCertificates}"/etc "$out/etc"
          '';

          runnerImageRoot = pkgs.runCommand "runner-image-root" { } ''
            mkdir -p "$out"
            cp -R "${runnerAppRoot}"/. "$out/"
            cp -R "${tofuRoot}"/usr "$out/usr"
            cp -R "${pkgs.dockerTools.caCertificates}"/etc "$out/etc"
          '';

          bunSlimBase = pkgs.dockerTools.pullImage {
            imageName = "oven/bun";
            finalImageName = "oven/bun";
            finalImageTag = "1-slim";
            imageDigest = "sha256:7e8ed3961db1cdedf17d516dda87948cfedbd294f53bf16462e5b57ed3fff0f1";
            outputHash = "sha256-GaxQdlDlpbCaxHX4BCOJp6m/RHc0WY9HIq+ke+1OaPg=";
            outputHashAlgo = "sha256";
            arch = "arm64";
          };

          control-plane-image = pkgs.dockerTools.buildImage {
            name = "yaffle-control-plane";
            tag = "latest";
            architecture = "arm64";
            fromImage = bunSlimBase;
            copyToRoot = controlPlaneImageRoot;
            config = {
              WorkingDir = "/app";
              Cmd = [ "bun" "index.js" ];
              Env = bunBaseEnv ++ [
                "PORT=3000"
                "NODE_ENV=production"
                "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt"
              ];
              ExposedPorts = {
                "3000/tcp" = { };
              };
            };
          };

          web-image = pkgs.dockerTools.buildImage {
            name = "yaffle-web";
            tag = "latest";
            architecture = "arm64";
            fromImage = bunSlimBase;
            copyToRoot = webImageRoot;
            config = {
              WorkingDir = "/app";
              Cmd = [ "bun" "run" "index.js" ];
              Env = bunBaseEnv ++ [
                "PORT=3000"
                "NODE_ENV=production"
                "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt"
              ];
              ExposedPorts = {
                "3000/tcp" = { };
              };
            };
          };

          runner-image = pkgs.dockerTools.buildImage {
            name = "yaffle-runner";
            tag = "latest";
            architecture = "arm64";
            fromImage = bunSlimBase;
            copyToRoot = runnerImageRoot;
            config = {
              WorkingDir = "/workspace";
              Cmd = [ "bun" "run" "/app/apps/runner/src/worker.ts" ];
              Env = bunBaseEnv ++ [
                "HOME=/tmp"
                "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt"
              ];
            };
          };

          yaffle-cli = pkgs.callPackage ./nix/yaffle-cli.nix {
            inherit pkgs;
            lib = pkgs.lib;
            src = repoRoot;
          };

          lambda-layer-tailscale = pkgs.callPackage ./nix/lambda-layers/tailscale-layer.nix {
            inherit pkgs;
            lib = pkgs.lib;
          };
        in {
          inherit
            control-plane-image
            lambda-layer-tailscale
            runner-image
            web-image
            yaffle-cli;
          default = yaffle-cli;
          yaffle-outputs = yaffle-cli;
        }
      );

      apps = forEachSystem (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          yaffle-cli = self.packages.${system}.yaffle-cli;
          ciPath = pkgs.lib.makeBinPath [
            pkgs.awscli2
            pkgs.bun
            pkgs.gh
            pkgs.git
            pkgs.nodejs_22
            pkgs.opentofu
            pkgs.skopeo
            pkgs.zip
          ];

          mkRepoBunApp = name: script: {
            type = "app";
            program = toString (pkgs.writeShellScript name ''
              if [ ! -f "${script}" ]; then
                echo "Error: Must run from yaffle repo root" >&2
                exit 1
              fi
              export PATH="${ciPath}:$PATH"
              exec bun run ${script} "$@"
            '');
          };
        in {
          yaffle-outputs = {
            type = "app";
            program = "${yaffle-cli}/bin/yaffle-outputs";
          };
          yaffle = {
            type = "app";
            program = toString (pkgs.writeShellScript "yaffle" ''
              if [ ! -f "Cargo.toml" ]; then
                echo "Error: Must run from yaffle repo root" >&2
                exit 1
              fi
              export PATH="${pkgs.cargo}/bin:${pkgs.rustc}/bin:$PATH"
              exec cargo run -p yaffle-cli -- "$@"
            '');
          };
          ci = mkRepoBunApp "ci" "scripts/ci/main.ts";
          deploy-marketing = mkRepoBunApp "deploy-marketing" "scripts/deploy-marketing.ts";
          deploy-docs = mkRepoBunApp "deploy-docs" "scripts/deploy-docs.ts";

          # CI/CD scripts — each independently runnable
          deploy-all = mkRepoBunApp "deploy-all" "scripts/deploy-all.ts";
          build-images = mkRepoBunApp "build-images" "scripts/build-images.ts";
          build-cp = mkRepoBunApp "build-cp" "scripts/build-cp.ts";
          build-web = mkRepoBunApp "build-web" "scripts/build-web.ts";
          build-runner = mkRepoBunApp "build-runner" "scripts/build-runner.ts";
          deploy = mkRepoBunApp "deploy" "scripts/deploy.ts";
          deploy-cp = mkRepoBunApp "deploy-cp" "scripts/deploy-cp.ts";
          deploy-web = mkRepoBunApp "deploy-web" "scripts/deploy-web.ts";
          deploy-runner = mkRepoBunApp "deploy-runner" "scripts/deploy-runner.ts";
          build-scanner = mkRepoBunApp "build-scanner" "scripts/build-scanner.ts";
          build-provider-discovery-agent = mkRepoBunApp "build-provider-discovery-agent" "scripts/build-provider-discovery-agent.ts";
          build-tc = mkRepoBunApp "build-tc" "scripts/build-tc.ts";
          deploy-scanner = mkRepoBunApp "deploy-scanner" "scripts/deploy-scanner.ts";
          deploy-tc = mkRepoBunApp "deploy-tc" "scripts/deploy-tc.ts";
          deploy-provider-discovery-agent = mkRepoBunApp "deploy-provider-discovery-agent" "scripts/deploy-provider-discovery-agent.ts";
          test-scanner-lambda = mkRepoBunApp "test-scanner-lambda" "scripts/test-scanner-lambda.ts";
          publish-scanner-layers = mkRepoBunApp "publish-scanner-layers" "scripts/publish-scanner-layers.ts";
          db-migrate = mkRepoBunApp "db-migrate" "scripts/db-migrate.ts";
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
        in {
          ci = pkgs.mkShell {
            packages = with pkgs; [
              awscli2
              bun
              gh
              git
              nodejs_22
              opentofu
              skopeo
              zip
            ];
          };

          default = pkgs.mkShell {
            packages = with pkgs; [
              # JavaScript / TypeScript
              bun
              nodejs_22

              # Rust
              cargo
              rustc
              rustfmt
              clippy
              rust-analyzer

              # Infrastructure
              opentofu
              awscli2
              skopeo
              zip

              # Database
              postgresql_17
              pscale

              # Secrets
              _1password-cli

              # Version control / GitHub
              gh
              git
              jujutsu

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
              echo "  cargo            $(cargo --version)"
              echo "  rustc            $(rustc --version)"
              echo "  tofu             $(tofu --version | head -1)"
              echo "  psql             $(psql --version)"
              echo "  jj               $(jj --version)"
              echo "  process-compose  $(process-compose version | head -1)"
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
          };
        }
      );
    };
}
