#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" != "--" ]; then
  echo "usage: scripts/assume-control-plane-role.sh -- <command...>" >&2
  exit 1
fi
shift

if [ "$#" -eq 0 ]; then
  echo "missing command after --" >&2
  exit 1
fi

ROLE_ARN="${YAFFLE_CONTROL_PLANE_ROLE_ARN:-}"
if [ -z "$ROLE_ARN" ]; then
  echo "YAFFLE_CONTROL_PLANE_ROLE_ARN must be set" >&2
  exit 1
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required to assume control-plane role" >&2
  exit 1
fi

SESSION_NAME="yaffle-dev-$(whoami)-$(date +%s)"

assume_role_cmd() {
  aws "$@" sts assume-role \
    --role-arn "$ROLE_ARN" \
    --role-session-name "$SESSION_NAME" \
    --duration-seconds 3600 \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken,Expiration]' \
    --output text
}

ASSUME_OUTPUT=""

set +e
ASSUME_OUTPUT="$(assume_role_cmd 2> >(cat >&2))"
ASSUME_STATUS=$?
set -e

if [ $ASSUME_STATUS -ne 0 ]; then
  # Root AWS credentials cannot assume roles. Retry using profile credentials
  # with injected static env keys removed.
  SOURCE_PROFILE="${YAFFLE_ASSUME_SOURCE_PROFILE:-${AWS_PROFILE:-${AWS_DEFAULT_PROFILE:-default}}}"

  PROFILE_LIST_RAW="$(aws configure list-profiles 2>/dev/null || true)"
  PROFILE_LIST="$(printf "%s" "$PROFILE_LIST_RAW" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g' | sed 's/^ //;s/ $//')"

  if [ -z "$PROFILE_LIST" ]; then
    echo "No AWS CLI profiles found. Configure one and log in first (for example: aws sso login --profile <profile>)." >&2
    echo "Then set YAFFLE_ASSUME_SOURCE_PROFILE=<profile>." >&2
    exit 1
  fi

  if ! printf "%s\n" "$PROFILE_LIST_RAW" | grep -Fxq "$SOURCE_PROFILE"; then
    SOURCE_PROFILE="$(printf "%s\n" "$PROFILE_LIST_RAW" | head -n 1)"
  fi

  echo "Retrying assume-role using AWS profile '${SOURCE_PROFILE}' (without injected AWS_* env keys)..." >&2

  set +e
  ASSUME_OUTPUT="$(env \
    -u AWS_ACCESS_KEY_ID \
    -u AWS_SECRET_ACCESS_KEY \
    -u AWS_SESSION_TOKEN \
    -u AWS_SECURITY_TOKEN \
    -u AWS_SESSION_EXPIRATION \
    aws --profile "$SOURCE_PROFILE" sts assume-role \
      --role-arn "$ROLE_ARN" \
      --role-session-name "$SESSION_NAME" \
      --duration-seconds 3600 \
      --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken,Expiration]' \
      --output text 2> >(cat >&2))"
  ASSUME_STATUS=$?
  set -e

  if [ $ASSUME_STATUS -ne 0 ]; then
    echo "failed to assume control-plane role with profile '${SOURCE_PROFILE}'." >&2
    echo "Available profiles: ${PROFILE_LIST}" >&2
    echo "If needed, set YAFFLE_ASSUME_SOURCE_PROFILE=<profile> and run 'aws sso login --profile <profile>'." >&2
    exit 1
  fi
fi

read -r ACCESS_KEY SECRET_KEY SESSION_TOKEN EXPIRATION <<< "$ASSUME_OUTPUT"

if [ -z "${ACCESS_KEY:-}" ] || [ -z "${SECRET_KEY:-}" ] || [ -z "${SESSION_TOKEN:-}" ]; then
  echo "failed to assume control-plane role: missing credential fields" >&2
  exit 1
fi

export AWS_ACCESS_KEY_ID="$ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$SECRET_KEY"
export AWS_SESSION_TOKEN="$SESSION_TOKEN"

echo "Assumed control-plane role: $ROLE_ARN (expires: $EXPIRATION)" >&2

exec "$@"
