#!/usr/bin/env bash
# Build the control-plane container image
#
# Usage:
#   ./scripts/build-control-plane-image.sh
#   ./scripts/build-control-plane-image.sh --push  # Also push to registry

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$ROOT_DIR"

PUSH_FLAGS=""
if [[ "${1:-}" == "--push" ]]; then
  PUSH_FLAGS="--push"
fi

echo "==> Building control-plane image with Nix..."
if [[ -n "$PUSH_FLAGS" ]]; then
  YAFFLE_PUSH=true nix run .#build-cp
else
  YAFFLE_PUSH=false nix run .#build-cp
fi

echo "==> Image built successfully!"
