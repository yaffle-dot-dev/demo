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
          pkgs = import nixpkgs {
            inherit system;
          };
          armPkgs = import nixpkgs {
            system = "aarch64-linux";
          };
          lib = pkgs.lib;
          imagePnpm = pkgs.pnpm_10;
          imageBuildId = self.rev or "dirty";
          imageBuildTimestamp = if self ? rev then toString self.lastModified else "0";
          repoRoot = ./.;
          repoRootString = toString repoRoot;

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
            "packages/test/package.json"
            "packages/yaffle-client/package.json"
          ];

          rootWorkspaceFiles = [
            "package.json"
            "pnpm-lock.yaml"
            "pnpm-workspace.yaml"
            "tsconfig.json"
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

          pnpmDepsSource = mkSourceTree "pnpm-deps-src" (
            rootWorkspaceFiles
            ++ workspaceManifestPaths
          );

          mkPnpmDeps = name: pnpmWorkspaces: pnpmInstallFlags: hash: pkgs.fetchPnpmDeps {
            pname = "yaffle-${name}";
            version = "0.1.0";
            src = pnpmDepsSource;
            pnpm = imagePnpm;
            inherit pnpmInstallFlags pnpmWorkspaces;
            fetcherVersion = 3;
            inherit hash;
          };

          controlPlaneWorkspaces = [ "@yaffle/control-plane" "@yaffle/shared" ];
          webWorkspaces = [ "@yaffle/web" "@yaffle/design" "@yaffle/shared" ];
          runnerWorkspaces = [ "@yaffle/runner" "@yaffle/shared" ];
          productionInstallFlags = [
            "--child-concurrency=1"
            "--network-concurrency=4"
            "--prod"
          ];

          controlPlanePnpmDeps = mkPnpmDeps
            "control-plane"
            controlPlaneWorkspaces
            productionInstallFlags
            "sha256-j07c6tTmqKILgD/Aan0SvMSDxgxQrXdLlgAzg8x6AAs=";
          webPnpmDeps = mkPnpmDeps
            "web"
            webWorkspaces
            productionInstallFlags
            "sha256-hUSkUJgnorhqtbXBeL+6/DwB2dbWWp59m29+pWLhtX8=";
          runnerPnpmDeps = mkPnpmDeps
            "runner"
            runnerWorkspaces
            productionInstallFlags
            "sha256-SvPN6i6GexDEUL1pzPBdrAh5g1rbEkhx/1XT6EXtrCg=";

          mkPnpmWorkspaceBuild = {
            name,
            srcTree,
            pnpmDeps,
            pnpmInstallFlags ? [ ],
            pnpmWorkspaces,
            extraNativeBuildInputs ? [ ],
            buildCommands,
            installCommands,
          }:
            pkgs.stdenv.mkDerivation {
              pname = name;
              version = "0.1.0";
              src = srcTree;
              inherit pnpmDeps pnpmWorkspaces;
              prePnpmInstall = ''
                pnpmInstallFlags+=(
                  ${lib.concatMapStringsSep "\n" lib.escapeShellArg pnpmInstallFlags}
                )
              '';

              nativeBuildInputs = [
                pkgs.nodejs_26
                imagePnpm
                pkgs.pnpmConfigHook
                pkgs.cacert
              ] ++ extraNativeBuildInputs;

              configurePhase = ''
                runHook preConfigure
                export HOME="$TMPDIR/home"
                mkdir -p "$HOME"
                cd "$NIX_BUILD_TOP/$sourceRoot"
                echo "=== ${name}: configurePhase start $(date -Iseconds) ==="
                echo "${name}: node version $(node --version)"
                echo "${name}: pnpm version ${imagePnpm.version}"
                echo "=== ${name}: configurePhase end $(date -Iseconds) ==="
                runHook postConfigure
              '';

              buildPhase = ''
                runHook preBuild
                cd "$NIX_BUILD_TOP/$sourceRoot"
                echo "=== ${name}: buildPhase start $(date -Iseconds) ==="
                ${buildCommands}
                echo "=== ${name}: buildPhase end $(date -Iseconds) ==="
                runHook postBuild
              '';

              installPhase = ''
                runHook preInstall
                cd "$NIX_BUILD_TOP/$sourceRoot"
                echo "=== ${name}: installPhase start $(date -Iseconds) ==="
                ${installCommands}
                echo "=== ${name}: installPhase end $(date -Iseconds) ==="
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

          controlPlaneBundle = mkPnpmWorkspaceBuild {
            name = "control-plane-bundle";
            srcTree = controlPlaneSource;
            pnpmDeps = controlPlanePnpmDeps;
            pnpmInstallFlags = productionInstallFlags;
            pnpmWorkspaces = controlPlaneWorkspaces;
            extraNativeBuildInputs = [ pkgs.esbuild ];
            buildCommands = ''
               esbuild apps/control-plane/src/index.ts \
                 --banner:js='import { createRequire as __yaffleCreateRequire } from "node:module"; const require = __yaffleCreateRequire(import.meta.url);' \
                 --bundle \
                 --external:minijinja-js \
                --format=esm \
                --out-extension:.js=.mjs \
                --outdir=apps/control-plane/dist \
                --platform=node \
                --target=node25
            '';
            installCommands = ''
              mkdir -p "$out/dist" "$out/node_modules"
              cp -R apps/control-plane/dist/. "$out/dist/"
              cp -RL apps/control-plane/node_modules/minijinja-js "$out/node_modules/minijinja-js"
            '';
          };

          webBundle = mkPnpmWorkspaceBuild {
            name = "web-bundle";
            srcTree = webSource;
            pnpmDeps = webPnpmDeps;
            pnpmInstallFlags = productionInstallFlags;
            pnpmWorkspaces = webWorkspaces;
            buildCommands = ''
              export SOURCE_DATE_EPOCH=${lib.escapeShellArg imageBuildTimestamp}
              export YAFFLE_BUILD_ID=${lib.escapeShellArg imageBuildId}
              pnpm --filter @yaffle/web exec vite build
            '';
            installCommands = ''
              kitPath="$(readlink -f apps/web/node_modules/@sveltejs/kit)"
              kitDependencies="$(dirname "$(dirname "$kitPath")")"
              mkdir -p "$out/node_modules/@sveltejs"
              cp -R apps/web/build/. "$out/"
              cp -RL "$kitPath" "$out/node_modules/@sveltejs/kit"
              rm -rf "$out/node_modules/@sveltejs/kit/node_modules"
              cp -RL "$kitDependencies/esm-env" "$out/node_modules/esm-env"
            '';
          };

          runnerBundle = mkPnpmWorkspaceBuild {
            name = "runner-bundle";
            srcTree = runnerSource;
            pnpmDeps = runnerPnpmDeps;
            pnpmInstallFlags = productionInstallFlags;
            pnpmWorkspaces = runnerWorkspaces;
            extraNativeBuildInputs = [ pkgs.esbuild ];
            buildCommands = ''
              esbuild \
                apps/runner/src/worker.ts \
                apps/runner/src/warm-runner.ts \
                apps/runner/src/scanner.ts \
                apps/runner/src/scanner-lambda.ts \
                --bundle \
                --format=esm \
                --out-extension:.js=.mjs \
                --outdir=apps/runner/dist \
                --platform=node \
                --splitting \
                --target=node25
            '';
            installCommands = ''
              mkdir -p "$out/dist"
              cp -R apps/runner/dist/. "$out/dist/"
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
            mkdir -p "$out/app/dist" "$out/app/node_modules" "$out/tmp"
            chmod 1777 "$out/tmp"
            cp -R "${controlPlaneBundle}"/dist/. "$out/app/dist/"
            cp -R "${controlPlaneBundle}"/node_modules/. "$out/app/node_modules/"
            cat > "$out/app/package.json" <<'EOF'
            {"type":"module"}
            EOF
          '';

          webImageRoot = pkgs.runCommand "web-image-root" { } ''
            mkdir -p "$out/app" "$out/tmp"
            chmod 1777 "$out/tmp"
            cp -R "${webBundle}"/. "$out/app/"
            cat > "$out/app/package.json" <<'EOF'
            {"type":"module"}
            EOF
          '';

          runnerImageRoot = pkgs.runCommand "runner-image-root" { } ''
            mkdir -p "$out/app/dist" "$out/tmp"
            chmod 1777 "$out/tmp"
            cp -R "${runnerBundle}"/dist/. "$out/app/dist/"
            cat > "$out/app/package.json" <<'EOF'
            {"type":"module"}
            EOF
          '';

          controlPlaneRuntimeRoot = pkgs.buildEnv {
            name = "control-plane-runtime-root";
            paths = [
              controlPlaneImageRoot
              pkgs.dockerTools.caCertificates
              armPkgs.git
              armPkgs.gnutar
              armPkgs.gzip
              armPkgs.nodejs_26
            ];
            pathsToLink = [ "/app" "/bin" "/etc" "/tmp" ];
          };

          webRuntimeRoot = pkgs.buildEnv {
            name = "web-runtime-root";
            paths = [
              webImageRoot
              pkgs.dockerTools.caCertificates
              armPkgs.nodejs_26
            ];
            pathsToLink = [ "/app" "/bin" "/etc" "/tmp" ];
          };

          runnerRuntimeRoot = pkgs.buildEnv {
            name = "runner-runtime-root";
            paths = [
              runnerImageRoot
              tofuRoot
              pkgs.dockerTools.caCertificates
              armPkgs.gnutar
              armPkgs.gzip
              armPkgs.nodejs_26
            ];
            pathsToLink = [ "/app" "/bin" "/etc" "/tmp" "/usr" ];
          };

          control-plane-image = pkgs.dockerTools.buildImage {
            name = "yaffle-control-plane";
            tag = "latest";
            architecture = "arm64";
            copyToRoot = controlPlaneRuntimeRoot;
            config = {
              WorkingDir = "/app";
              Cmd = [ "/bin/node" "dist/index.mjs" ];
              Env = [
                "PATH=/bin:/usr/bin"
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
            copyToRoot = webRuntimeRoot;
            config = {
              WorkingDir = "/app";
              Cmd = [ "/bin/node" "index.js" ];
              Env = [
                "PATH=/bin:/usr/bin"
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
            copyToRoot = runnerRuntimeRoot;
            config = {
              WorkingDir = "/workspace";
              Cmd = [ "/bin/node" "/app/dist/worker.mjs" ];
              Env = [
                "PATH=/bin:/usr/bin"
                "HOME=/tmp"
                "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt"
              ];
            };
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
            web-image;
          default = control-plane-image;
        }
      );

      apps = forEachSystem (system:
        let
          pkgs = import nixpkgs {
            inherit system;
          };
          repoVp = pkgs.writeShellScriptBin "vp" ''
            if [ ! -f package.json ]; then
              echo "Error: Must run from yaffle repo root" >&2
              exit 1
            fi

            exec ${pkgs.pnpm}/bin/pnpm exec vp "$@"
          '';
          ciPath = pkgs.lib.makeBinPath [
            pkgs.awscli2
            pkgs.gh
            pkgs.git
            pkgs.nodejs_26
            pkgs.opentofu
            pkgs.pnpm
            repoVp
            pkgs.skopeo
            pkgs.zip
          ];

          mkRepoNodeApp = name: script: {
            type = "app";
            program = toString (pkgs.writeShellScript name ''
              if [ ! -f "${script}" ]; then
                echo "Error: Must run from yaffle repo root" >&2
                exit 1
              fi
              export PATH="${ciPath}:$PATH"
              exec ${pkgs.pnpm}/bin/pnpm exec vp run ${name} "$@"
            '');
          };
        in {
          vp = {
            type = "app";
            program = "${repoVp}/bin/vp";
          };
          ci = mkRepoNodeApp "ci" "scripts/ci/main.ts";
          deploy-marketing = mkRepoNodeApp "deploy-marketing" "scripts/deploy-marketing.ts";
          deploy-docs = mkRepoNodeApp "deploy-docs" "scripts/deploy-docs.ts";

          # CI/CD scripts — each independently runnable
          deploy-all = mkRepoNodeApp "deploy-all" "scripts/deploy-all.ts";
          build-images = mkRepoNodeApp "build-images" "scripts/build-images.ts";
          build-cp = mkRepoNodeApp "build-cp" "scripts/build-cp.ts";
          build-web = mkRepoNodeApp "build-web" "scripts/build-web.ts";
          build-runner = mkRepoNodeApp "build-runner" "scripts/build-runner.ts";
          deploy = mkRepoNodeApp "deploy" "scripts/deploy.ts";
          deploy-cp = mkRepoNodeApp "deploy-cp" "scripts/deploy-cp.ts";
          deploy-web = mkRepoNodeApp "deploy-web" "scripts/deploy-web.ts";
          deploy-runner = mkRepoNodeApp "deploy-runner" "scripts/deploy-runner.ts";
          build-scanner = mkRepoNodeApp "build-scanner" "scripts/build-scanner.ts";
          build-provider-discovery-agent = mkRepoNodeApp "build-provider-discovery-agent" "scripts/build-provider-discovery-agent.ts";
          build-tc = mkRepoNodeApp "build-tc" "scripts/build-tc.ts";
          deploy-scanner = mkRepoNodeApp "deploy-scanner" "scripts/deploy-scanner.ts";
          deploy-tc = mkRepoNodeApp "deploy-tc" "scripts/deploy-tc.ts";
          deploy-provider-discovery-agent = mkRepoNodeApp "deploy-provider-discovery-agent" "scripts/deploy-provider-discovery-agent.ts";
          test-scanner-lambda = mkRepoNodeApp "test-scanner-lambda" "scripts/test-scanner-lambda.ts";
          publish-scanner-layers = mkRepoNodeApp "publish-scanner-layers" "scripts/publish-scanner-layers.ts";
          db-migrate = mkRepoNodeApp "db-migrate" "scripts/db-migrate.ts";
        }
      );

      devShells = forEachSystem (system:
        let
          pkgs = import nixpkgs {
            inherit system;
            config.allowUnfree = true;
          };
          repoVp = pkgs.writeShellScriptBin "vp" ''
            if [ ! -f package.json ]; then
              echo "Error: Must run from yaffle repo root" >&2
              exit 1
            fi

            exec ${pkgs.pnpm}/bin/pnpm exec vp "$@"
          '';
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
              gh
              git
              nodejs_26
              opentofu
              pnpm
              repoVp
              skopeo
              zip
            ];
          };

          default = pkgs.mkShell {
            packages = with pkgs; [
              # JavaScript / TypeScript
              nodejs_26
              pnpm

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
              repoVp
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
              echo "  node             $(node --version)"
              echo "  pnpm             $(pnpm --version)"
              if [ -x node_modules/.bin/vp ]; then
                echo "  vp               $(vp --version)"
              else
                echo "  vp               available after vp install"
              fi
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
              echo "  vp install                 - install dependencies via Vite+"
              echo "  vp run check               - run workspace type checks"
              echo "  vp run build               - run workspace builds"
              echo "  vp run dev:control-plane   - run the control plane"
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
