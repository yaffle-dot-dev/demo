# Nix derivation for the Yaffle runner
#
# This is a minimal container for executing tofu jobs in isolation.
# It contains only:
#   - OpenTofu
#   - AWS CLI (for S3 presigned URL operations)
#   - Basic shell utilities (curl, jq, tar)
#   - The entrypoint script
#
# The runner has NO access to Yaffle's internal infrastructure.
# All inputs are passed via presigned URLs and environment variables.
#
{ pkgs
, lib ? pkgs.lib
}:

pkgs.stdenv.mkDerivation {
  pname = "yaffle-runner";
  version = "0.1.0";

  # Just copy the entrypoint script
  src = ../apps/runner;

  dontBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p $out/bin
    cp entrypoint.sh $out/bin/yaffle-runner
    chmod +x $out/bin/yaffle-runner

    runHook postInstall
  '';

  meta = with lib; {
    description = "Yaffle runner - isolated tofu execution environment";
    homepage = "https://yaffle.dev";
    license = licenses.mit;
    platforms = platforms.linux;  # ECS runs on Linux
  };
}
