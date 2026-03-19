# Nix derivation for packaging the Yaffle control-plane
#
# IMPORTANT: This does NOT build the JavaScript - it only packages a pre-built bundle.
# The JS build happens in CI using standard bun tooling, then this packages it into
# a container image via nix2container.
#
# Why? Nix's sandbox blocks network access, but bun/npm need to download packages.
# While tools like node2nix exist, they're fragile and add maintenance burden.
# Building JS outside nix and packaging with nix is the pragmatic production approach.
#
# Usage:
#   nix build .#control-plane-image  # Requires pre-built bundle at ./dist/control-plane/
#
{ pkgs
, lib ? pkgs.lib
, bundlePath ? null  # Path to pre-built bundle directory (contains index.js + node_modules)
}:

let
  # Check environment variable for bundle path (set by CI or build script)
  envBundlePath = builtins.getEnv "YAFFLE_BUNDLE_PATH";
  effectiveBundlePath =
    if bundlePath != null then bundlePath
    else if envBundlePath != "" then /. + envBundlePath
    else null;
in
pkgs.stdenv.mkDerivation {
  pname = "yaffle-control-plane";
  version = "0.1.0";

  # Use the pre-built bundle
  src = if effectiveBundlePath != null
    then effectiveBundlePath
    else throw ''
      yaffle-control-plane requires a pre-built JavaScript bundle.

      Option 1 - Set environment variable:
        export YAFFLE_BUNDLE_PATH=/path/to/dist/control-plane
        nix build .#control-plane-image

      Option 2 - Use the build script:
        ./scripts/build-control-plane-image.sh

      The bundle directory must contain:
        - index.js (the bundled app)
        - node_modules/minijinja-js/ (WASM dependency)
    '';

  # No build phase - bundle is pre-built
  dontBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p $out/app $out/bin

    # Copy the bundle
    cp -r ./* $out/app/

    # Create wrapper script
    cat > $out/bin/yaffle-control-plane <<'EOF'
#!/bin/sh
cd $out/app
exec ${pkgs.bun}/bin/bun run $out/app/index.js "$@"
EOF
    chmod +x $out/bin/yaffle-control-plane

    # Fix the path in the wrapper (nix doesn't expand $out in heredocs)
    substituteInPlace $out/bin/yaffle-control-plane \
      --replace-fail '$out' "$out"

    runHook postInstall
  '';

  meta = with lib; {
    description = "Yaffle control-plane API server";
    homepage = "https://yaffle.dev";
    license = licenses.mit;
    platforms = platforms.all;
  };
}
