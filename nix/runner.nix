# Nix derivation for the Yaffle runner
#
# Packages the Bun-based TypeScript worker used by both local and ECS runners.
# The image entrypoint invokes Bun directly on `src/worker.ts`.
#
# The runner has NO access to Yaffle internals. It only receives:
#   - YAFFLE_JOB_ID
#   - YAFFLE_JOB_TOKEN
#   - YAFFLE_API_URL
#
# All execution context is fetched from the control plane API.

{ pkgs
, lib ? pkgs.lib
}:

pkgs.stdenv.mkDerivation {
  pname = "yaffle-runner";
  version = "0.1.0";

  src = ../apps/runner;

  dontBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p $out/app
    cp -R src $out/app/
    cp package.json $out/app/
    cp tsconfig.json $out/app/

    runHook postInstall
  '';

  meta = with lib; {
    description = "Yaffle runner - Bun worker for isolated tofu execution";
    homepage = "https://yaffle.dev";
    license = licenses.mit;
    platforms = platforms.linux;
  };
}
