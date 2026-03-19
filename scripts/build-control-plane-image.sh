#!/usr/bin/env bash
# Build the control-plane container image
#
# This script:
# 1. Builds the JavaScript bundle with Bun
# 2. Packages it into a container image with nix2container
#
# Usage:
#   ./scripts/build-control-plane-image.sh
#   ./scripts/build-control-plane-image.sh --push  # Also push to registry

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BUNDLE_DIR="$ROOT_DIR/dist/control-plane"

cd "$ROOT_DIR"

echo "==> Installing dependencies..."
bun install --frozen-lockfile

echo "==> Building control-plane bundle..."
rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR/node_modules"

bun build apps/control-plane/src/index.ts \
  --outdir "$BUNDLE_DIR" \
  --target bun \
  --external minijinja-js

# Copy WASM modules that can't be bundled
cp -r node_modules/.bun/minijinja-js@*/node_modules/minijinja-js "$BUNDLE_DIR/node_modules/"

echo "==> Bundle created at $BUNDLE_DIR"
ls -la "$BUNDLE_DIR"

echo "==> Building container image with nix..."
# --impure allows reading YAFFLE_BUNDLE_PATH env var
export YAFFLE_BUNDLE_PATH="$BUNDLE_DIR"
nix build .#control-plane-image --impure -L

echo "==> Image built successfully!"
echo "    Result: ./result"
echo ""
echo "To load into docker:"
echo "    ./result/copyTo docker-daemon:yaffle-control-plane:latest"
echo ""
echo "To push to a registry:"
echo "    ./result/copyTo docker://your-registry/yaffle-control-plane:tag"
