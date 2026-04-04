{ pkgs, lib, ... }:

# Build a Lambda layer zip containing Tailscale binaries + extension bootstrap.
#
# Downloads pre-built static Tailscale binaries from GitHub releases
# instead of building from source (avoids cross-compilation pain).
#
# At runtime, the extension starts tailscaled in userspace networking mode
# and exposes a SOCKS5 proxy on localhost:1055.
#
# This layer is optional — only needed for environments where the Lambda
# needs tailnet access (dev/staging). Production uses internal DNS.
let
  version = "1.82.5";

  tailscaleBin = pkgs.fetchurl {
    url = "https://pkgs.tailscale.com/stable/tailscale_${version}_arm64.tgz";
    sha256 = "sha256-g2GqO8DLv9eTY/704WuGy0uLWxjRhvm8XC3835gdnUQ=";
  };
in
pkgs.runCommand "lambda-layer-tailscale" {
  nativeBuildInputs = [ pkgs.gnutar pkgs.gzip pkgs.zip ];
} ''
  mkdir -p $out layer/bin

  # Extract tailscale binaries from the release tarball
  tar -xzf ${tailscaleBin} --strip-components=1 -C layer/bin \
    tailscale_${version}_arm64/tailscale \
    tailscale_${version}_arm64/tailscaled

  # Include a helper script (not an extension — started by the handler)
  cat > layer/bin/start-tailscale <<'SCRIPT'
#!/bin/sh
# Tailscale Lambda Extension
# Starts tailscaled + authenticates before the function handler runs.

mkdir -p /tmp/tailscale/state

if [ -z "$TAILSCALE_AUTHKEY" ] && [ -n "$TAILSCALE_AUTHKEY_SECRET_ARN" ]; then
  for i in 1 2 3 4 5; do
    curl -sf http://localhost:2773/health > /dev/null 2>&1 && break
    sleep 0.2
  done

  TAILSCALE_AUTHKEY=$(curl -sf \
    "http://localhost:2773/secretsmanager/get?secretId=''${TAILSCALE_AUTHKEY_SECRET_ARN}" \
    -H "X-Aws-Parameters-Secrets-Token: ''${AWS_SESSION_TOKEN}" \
    | jq -r '.SecretString | fromjson | .authkey' 2>/dev/null || true)
fi

if [ -n "$TAILSCALE_AUTHKEY" ]; then
  /opt/bin/tailscaled \
    --tun=userspace-networking \
    --socks5-server=localhost:1055 \
    --state=/tmp/tailscale/state/tailscale.state \
    --socket=/tmp/tailscale/tailscaled.sock \
    --no-logs-no-support &

  sleep 1

  /opt/bin/tailscale up \
    --authkey="''${TAILSCALE_AUTHKEY}" \
    --hostname="''${TS_HOSTNAME:-yaffle-scanner-lambda}" \
    --socket=/tmp/tailscale/tailscaled.sock

  echo "[start-tailscale] connected"
else
  echo "[start-tailscale] no auth key, skipping"
fi
SCRIPT

  chmod +x layer/bin/start-tailscale

  cd layer
  zip -r $out/tailscale-layer.zip .
''
