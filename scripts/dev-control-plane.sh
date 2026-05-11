#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${YAFFLE_DEV_RUNNER_MODE:-ecs}"
SECRETS_ENV_FILE="${YAFFLE_DEV_SECRETS_ENV_FILE:-env/dev/secrets.1password.env}"
LOCK_DIR="$ROOT_DIR/.dev/locks/control-plane.lock"
LOCK_PID_FILE="$LOCK_DIR/pid"

mkdir -p "$ROOT_DIR/.dev/locks"

if mkdir "$LOCK_DIR" 2>/dev/null; then
  printf "%s\n" "$$" > "$LOCK_PID_FILE"
else
  existing_pid=""
  if [ -f "$LOCK_PID_FILE" ]; then
    existing_pid="$(cat "$LOCK_PID_FILE" 2>/dev/null || true)"
  fi

  if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
    echo "control-plane launcher already running (pid: $existing_pid)" >&2
    exit 1
  fi

  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR"
  printf "%s\n" "$$" > "$LOCK_PID_FILE"
fi

cleanup_lock() {
  rm -rf "$LOCK_DIR"
}

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

DOTENV_ARGS=(
  -f "$ROOT_DIR/env/dev/base.env"
  -f "$ROOT_DIR/$MODE_ENV"
)

if [ -e "$ROOT_DIR/$SECRETS_ENV_FILE" ]; then
  DOTENV_ARGS+=( -f "$ROOT_DIR/$SECRETS_ENV_FILE" )
else
  echo "Warning: secrets env file not found at $SECRETS_ENV_FILE (continuing without it)" >&2
fi

exec dotenvx run -o "${DOTENV_ARGS[@]}" -- \
  env "YAFFLE_USE_ECS_RUNNER=${USE_ECS_RUNNER}" bash -lc '
    set -euo pipefail
    ASSUME_CONTROL_PLANE_ROLE="${YAFFLE_ASSUME_CONTROL_PLANE_ROLE:-false}"

    if [ "$ASSUME_CONTROL_PLANE_ROLE" = "true" ]; then
      exec ./scripts/run-with-assumed-role-refresh.sh -- pnpm --dir apps/control-plane dev
    fi

    exec pnpm --dir apps/control-plane dev
  '
