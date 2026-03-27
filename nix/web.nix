# Nix derivation for packaging the Yaffle web app (SvelteKit SSR)
#
# IMPORTANT: This does NOT build the JavaScript - it only packages a pre-built bundle.
# The JS build happens in CI using standard bun/vite tooling, then this packages it
# into a container image via nix2container.
#
# SvelteKit adapter-node outputs:
#   build/index.js    - entrypoint
#   build/handler.js  - request handler
#   build/server/     - server-side rendered pages
#   build/client/     - static client assets
#
# Usage:
#   nix build .#web-image  # Requires pre-built bundle at ./dist/web/
#
{ pkgs
, lib ? pkgs.lib
, bundlePath ? null
}:

let
  envBundlePath = builtins.getEnv "YAFFLE_WEB_BUNDLE_PATH";
  effectiveBundlePath =
    if bundlePath != null then bundlePath
    else if envBundlePath != "" then /. + envBundlePath
    else null;
in
pkgs.stdenv.mkDerivation {
  pname = "yaffle-web";
  version = "0.1.0";

  src = if effectiveBundlePath != null
    then effectiveBundlePath
    else throw ''
      yaffle-web requires a pre-built SvelteKit bundle.

      Option 1 - Set environment variable:
        export YAFFLE_WEB_BUNDLE_PATH=/path/to/apps/web/build
        nix build .#web-image --impure

      Option 2 - Build in CI:
        cd apps/web && bun run build
    '';

  dontBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p $out/app $out/bin

    # Copy the SvelteKit adapter-node build output
    cp -r ./* $out/app/

    # Create wrapper script
    cat > $out/bin/yaffle-web <<'EOF'
#!/bin/sh
cd $out/app
exec ${pkgs.bun}/bin/bun run $out/app/index.js "$@"
EOF
    chmod +x $out/bin/yaffle-web

    substituteInPlace $out/bin/yaffle-web \
      --replace-fail '$out' "$out"

    runHook postInstall
  '';

  meta = with lib; {
    description = "Yaffle web application (SvelteKit SSR)";
    homepage = "https://yaffle.dev";
    license = licenses.mit;
    platforms = platforms.all;
  };
}
