#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" != "--" ]; then
  echo "usage: scripts/run-with-assumed-role-refresh.sh -- <command...>" >&2
  exit 1
fi
shift

if [ "$#" -eq 0 ]; then
  echo "missing command after --" >&2
  exit 1
fi

ROLE_ARN="${YAFFLE_ASSUME_ROLE_ARN:-${YAFFLE_CONTROL_PLANE_ROLE_ARN:-}}"
if [ -z "$ROLE_ARN" ]; then
  echo "YAFFLE_ASSUME_ROLE_ARN or YAFFLE_CONTROL_PLANE_ROLE_ARN must be set" >&2
  exit 1
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required to assume control-plane role" >&2
  exit 1
fi

REFRESH_SECONDS="${YAFFLE_ASSUME_REFRESH_SECONDS:-3000}"
ASSUME_DURATION_SECONDS="${YAFFLE_ASSUME_DURATION_SECONDS:-3600}"
RESTART_GRACE_SECONDS="${YAFFLE_ASSUME_RESTART_GRACE_SECONDS:-20}"
SHUTDOWN_GRACE_SECONDS="${YAFFLE_ASSUME_SHUTDOWN_GRACE_SECONDS:-3}"

child_pid=""
sleep_pid=""
script_pgid="$(ps -o pgid= $$ 2>/dev/null | tr -d ' ' || true)"
cleanup_done="false"

list_descendants() {
  local parent="$1"
  local children child
  children="$(pgrep -P "$parent" 2>/dev/null || true)"
  if [ -z "$children" ]; then
    return 0
  fi

  for child in $children; do
    printf "%s\n" "$child"
    list_descendants "$child"
  done
}

signal_descendants() {
  local parent="$1"
  local signal="$2"
  local pid

  for pid in $(list_descendants "$parent" | sort -rn | uniq); do
    kill "-$signal" "$pid" 2>/dev/null || true
  done
}

get_pgid() {
  local pid="$1"
  ps -o pgid= "$pid" 2>/dev/null | tr -d ' ' || true
}

terminate_child() {
  local grace_seconds="$1"
  local child_pgid

  if [ -z "$child_pid" ] || ! kill -0 "$child_pid" 2>/dev/null; then
    return 0
  fi

  child_pgid="$(get_pgid "$child_pid")"

  signal_descendants "$child_pid" TERM

  if [ -n "$child_pgid" ] && [ "$child_pgid" != "$script_pgid" ]; then
    kill -TERM "-$child_pgid" 2>/dev/null || true
  fi
  kill -TERM "$child_pid" 2>/dev/null || true

  sleep "$grace_seconds"

  if kill -0 "$child_pid" 2>/dev/null; then
    signal_descendants "$child_pid" KILL

    if [ -n "$child_pgid" ] && [ "$child_pgid" != "$script_pgid" ]; then
      kill -KILL "-$child_pgid" 2>/dev/null || true
    fi
    kill -KILL "$child_pid" 2>/dev/null || true
  fi

  wait "$child_pid" 2>/dev/null || true
  child_pid=""
}

start_child() {
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" &
  else
    # macOS does not ship `setsid`; enable job control so the child gets its
    # own process group and can be terminated with its descendants.
    set -m
    "$@" &
    set +m
  fi
  child_pid=$!
}

cleanup() {
  if [ "$cleanup_done" = "true" ]; then
    return 0
  fi
  cleanup_done="true"

  if [ -n "$sleep_pid" ] && kill -0 "$sleep_pid" 2>/dev/null; then
    kill -TERM "$sleep_pid" 2>/dev/null || true
    wait "$sleep_pid" 2>/dev/null || true
    sleep_pid=""
  fi

  terminate_child "$SHUTDOWN_GRACE_SECONDS"
}

trap 'cleanup; exit 130' INT TERM
trap cleanup EXIT

assume_once() {
  local session_name output status source_profile profile_list_raw profile_list

  session_name="yaffle-dev-$(whoami)-$(date +%s)"

  set +e
  output="$(aws sts assume-role \
    --role-arn "$ROLE_ARN" \
    --role-session-name "$session_name" \
    --duration-seconds "$ASSUME_DURATION_SECONDS" \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken,Expiration]' \
    --output text 2> >(cat >&2))"
  status=$?
  set -e

  if [ $status -ne 0 ]; then
    source_profile="${YAFFLE_ASSUME_SOURCE_PROFILE:-${AWS_PROFILE:-${AWS_DEFAULT_PROFILE:-default}}}"
    profile_list_raw="$(aws configure list-profiles 2>/dev/null || true)"
    profile_list="$(printf "%s" "$profile_list_raw" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g' | sed 's/^ //;s/ $//')"

    if [ -z "$profile_list" ]; then
      echo "No AWS CLI profiles found. Configure one and log in first (for example: aws sso login --profile <profile>)." >&2
      echo "Then set YAFFLE_ASSUME_SOURCE_PROFILE=<profile>." >&2
      return 1
    fi

    if ! printf "%s\n" "$profile_list_raw" | grep -Fxq "$source_profile"; then
      source_profile="$(printf "%s\n" "$profile_list_raw" | head -n 1)"
    fi

    echo "Retrying assume-role using AWS profile '${source_profile}' (without injected AWS_* env keys)..." >&2

    set +e
    output="$(env \
      -u AWS_ACCESS_KEY_ID \
      -u AWS_SECRET_ACCESS_KEY \
      -u AWS_SESSION_TOKEN \
      -u AWS_SECURITY_TOKEN \
      -u AWS_SESSION_EXPIRATION \
      aws --profile "$source_profile" sts assume-role \
        --role-arn "$ROLE_ARN" \
        --role-session-name "$session_name" \
        --duration-seconds "$ASSUME_DURATION_SECONDS" \
        --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken,Expiration]' \
        --output text 2> >(cat >&2))"
    status=$?
    set -e

    if [ $status -ne 0 ]; then
      echo "failed to assume control-plane role with profile '${source_profile}'." >&2
      echo "Available profiles: ${profile_list}" >&2
      echo "If needed, set YAFFLE_ASSUME_SOURCE_PROFILE=<profile> and run 'aws sso login --profile <profile>'." >&2
      return 1
    fi
  fi

  read -r AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SESSION_EXPIRATION <<< "$output"
  if [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ] || [ -z "${AWS_SESSION_TOKEN:-}" ]; then
    echo "failed to assume control-plane role: missing credential fields" >&2
    return 1
  fi

  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SESSION_EXPIRATION
  echo "Assumed control-plane role: $ROLE_ARN (expires: ${AWS_SESSION_EXPIRATION})" >&2
}

while true; do
  assume_once

  start_child "$@"

  sleep "$REFRESH_SECONDS" &
  sleep_pid=$!

  while true; do
    if ! kill -0 "$child_pid" 2>/dev/null; then
      break
    fi
    if ! kill -0 "$sleep_pid" 2>/dev/null; then
      break
    fi
    sleep 1
  done

  if ! kill -0 "$child_pid" 2>/dev/null; then
    kill "$sleep_pid" 2>/dev/null || true
    wait "$child_pid"
    exit $?
  fi

  echo "Refreshing assumed role credentials; restarting child process..." >&2
  terminate_child "$RESTART_GRACE_SECONDS"
  kill "$sleep_pid" 2>/dev/null || true
  wait "$sleep_pid" 2>/dev/null || true
  sleep_pid=""
done
