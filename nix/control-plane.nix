# Nix derivation for building the Yaffle control-plane
#
# This builds the TypeScript source into a bundled JavaScript file using Bun.
# The output is a minimal directory containing just what's needed to run the server.
#
# Usage in devenv.nix:
#   let controlPlane = pkgs.callPackage ./nix/control-plane.nix { inherit pkgs; };
#
{ pkgs
, lib ? pkgs.lib
, src ? ../. # Root of the monorepo
}:

let
  # Filter to exclude unnecessary files (git, node_modules, dist, etc.)
  # This is simpler and less error-prone than an allowlist
  sourceFilter = path: type:
    let
      baseName = baseNameOf path;
      relativePath = lib.removePrefix (toString src + "/") (toString path);
    in
    # Exclude these
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
      # Exclude apps/web entirely - we only need control-plane
      lib.hasPrefix "apps/web" relativePath
    );

  filteredSrc = lib.cleanSourceWith {
    inherit src;
    filter = sourceFilter;
    name = "yaffle-control-plane-src";
  };

in
pkgs.stdenv.mkDerivation {
  pname = "yaffle-control-plane";
  version = "0.1.0";

  src = filteredSrc;

  nativeBuildInputs = [ pkgs.bun pkgs.cacert ];

  # Bun needs HOME for cache
  HOME = "/tmp";

  configurePhase = ''
    runHook preConfigure

    # Install dependencies - allow lockfile updates since we filtered the source
    # In CI, we'd use --frozen-lockfile after ensuring lockfile is committed
    bun install

    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild

    # Build the control-plane
    cd apps/control-plane
    bun build src/index.ts --outdir dist --target bun

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    # Create output directory structure
    mkdir -p $out/app

    # Copy the built bundle
    cp -r dist/* $out/app/

    # Create a wrapper script
    mkdir -p $out/bin
    cat > $out/bin/yaffle-control-plane <<EOF
#!/bin/sh
exec ${pkgs.bun}/bin/bun run $out/app/index.js "\$@"
EOF
    chmod +x $out/bin/yaffle-control-plane

    runHook postInstall
  '';

  meta = with lib; {
    description = "Yaffle control-plane API server";
    homepage = "https://yaffle.dev";
    license = licenses.mit;
    platforms = platforms.all;
  };
}
