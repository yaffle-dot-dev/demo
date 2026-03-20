#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${YAFFLE_DEV_RUNNER_MODE:-ecs}"
SECRETS_ENV_FILE="${YAFFLE_DEV_SECRETS_ENV_FILE:-env/dev/secrets.1password.env}"

case "$MODE" in
  local)
    MODE_ENV="env/dev/control-plane-local-runner.env"
    USE_ECS_RUNNER="false"
    ;;
  ecs)
    MODE_ENV="env/dev/control-plane-ecs-runner.env"
    USE_ECS_RUNNER="true"
    ;;
  *)
    echo "Unknown YAFFLE_DEV_RUNNER_MODE: $MODE (expected local or ecs)" >&2
    exit 1
    ;;
esac

RUN_CONTROL_PLANE_CMD='./scripts/assume-control-plane-role.sh -- bun run dev:control-plane'

DOTENV_ARGS=(
  -f "$ROOT_DIR/env/dev/base.env"
  -f "$ROOT_DIR/$MODE_ENV"
)

if [ -e "$ROOT_DIR/$SECRETS_ENV_FILE" ]; then
  DOTENV_ARGS+=( -f "$ROOT_DIR/$SECRETS_ENV_FILE" )
else
  echo "Warning: secrets env file not found at $SECRETS_ENV_FILE (continuing without it)" >&2
fi

exec bunx @dotenvx/dotenvx run -o "${DOTENV_ARGS[@]}" -- \
  bash -lc "export YAFFLE_USE_ECS_RUNNER=${USE_ECS_RUNNER}; ${RUN_CONTROL_PLANE_CMD}"
