#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$#" -lt 2 ]; then
  echo "usage: scripts/with-env.sh <env-file> [<env-file> ...] -- <command...>" >&2
  exit 1
fi

ENV_ARGS=()
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    break
  fi

  if [ ! -f "$ROOT_DIR/$1" ]; then
    echo "env file not found: $1" >&2
    exit 1
  fi

  ENV_ARGS+=("-f" "$ROOT_DIR/$1")
  shift
done

if [ "$#" -eq 0 ]; then
  echo "missing command after --" >&2
  exit 1
fi

exec bunx @dotenvx/dotenvx run -o "${ENV_ARGS[@]}" -- "$@"
