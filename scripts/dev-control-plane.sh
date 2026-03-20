#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${YAFFLE_DEV_RUNNER_MODE:-local}"

case "$MODE" in
  local)
    MODE_ENV="env/dev/control-plane-local-runner.env"
    ;;
  ecs)
    MODE_ENV="env/dev/control-plane-ecs-runner.env"
    ;;
  *)
    echo "Unknown YAFFLE_DEV_RUNNER_MODE: $MODE (expected local or ecs)" >&2
    exit 1
    ;;
esac

exec "$ROOT_DIR/scripts/with-env.sh" \
  env/dev/base.env \
  "$MODE_ENV" \
  -- bash -lc 'op signin 2>/dev/null || true && secretspec run -- bun run dev:control-plane'
