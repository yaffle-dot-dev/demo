# Nix derivation for building the Yaffle CLI tools
#
# Provides yaffle-outputs for fetching Terraform outputs from previews.
# Works both locally and in CI.
#
# Usage:
#   nix run .#yaffle-outputs -- --pr 123 --workspace apps/infra --wait
#
{ pkgs
, lib ? pkgs.lib
, src ? ../. # Root of the monorepo
}:

let
  # Filter out unnecessary files
  sourceFilter = path: type:
    let
      baseName = baseNameOf path;
      relativePath = lib.removePrefix (toString src + "/") (toString path);
    in
    # Exclude these patterns
    !(
      baseName == ".git" ||
      baseName == ".jj" ||
      baseName == "node_modules" ||
      baseName == "dist" ||
      baseName == ".devenv" ||
      baseName == ".direnv" ||
      baseName == "result" ||
      baseName == ".DS_Store" ||
      lib.hasSuffix ".log" baseName ||
      # Exclude other apps/packages we don't need
      lib.hasPrefix "apps/" relativePath ||
      lib.hasPrefix "packages/shared" relativePath ||
      lib.hasPrefix "packages/design" relativePath ||
      lib.hasPrefix "actions/" relativePath ||
      lib.hasPrefix "modules/" relativePath ||
      lib.hasPrefix "nix/" relativePath ||
      lib.hasPrefix ".github/" relativePath
    );

  filteredSrc = lib.cleanSourceWith {
    inherit src;
    filter = sourceFilter;
    name = "yaffle-cli-src";
  };

in
pkgs.stdenv.mkDerivation {
  pname = "yaffle-cli";
  version = "0.1.0";

  src = filteredSrc;

  nativeBuildInputs = [ pkgs.bun pkgs.cacert ];

  # Bun needs HOME for cache
  HOME = "/tmp";

  configurePhase = ''
    runHook preConfigure
    bun install
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild

    cd packages/cli
    bun build src/main.ts --outdir dist --target bun

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/app $out/bin

    # Copy the built bundle
    cp -r dist/* $out/app/

    # Create wrapper scripts
    cat > $out/bin/yaffle <<EOF
#!/bin/sh
exec ${pkgs.bun}/bin/bun run $out/app/main.js "$@"
EOF
    chmod +x $out/bin/yaffle

    cat > $out/bin/yaffle-outputs <<EOF
#!/bin/sh
exec ${pkgs.bun}/bin/bun run $out/app/main.js outputs "\$@"
EOF
    chmod +x $out/bin/yaffle-outputs

    runHook postInstall
  '';

  meta = with lib; {
    description = "Yaffle CLI tools";
    homepage = "https://yaffle.dev";
    license = licenses.mit;
    platforms = platforms.all;
  };
}
