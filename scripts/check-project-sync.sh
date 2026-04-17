#!/usr/bin/env bash

set -euo pipefail

PROJECT="${PROJECT:-}"
SOURCE_PATH="${SOURCE_PATH:-}"
TARGET_REPOSITORY="${TARGET_REPOSITORY:-}"
TARGET_BRANCH="${TARGET_BRANCH:-main}"
PUBLIC_TOKEN="${PUBLIC_TOKEN:-}"
ALLOW_BOOTSTRAP="${ALLOW_BOOTSTRAP:-false}"

ROOT_DIR="$(git rev-parse --show-toplevel)"
TMP_DIR="$(mktemp -d)"
PUBLIC_DIR="$TMP_DIR/public"

fail() {
  printf '::error::%s\n' "$*" >&2
  exit 1
}

cleanup() {
  rm -rf "$TMP_DIR"
}

trap cleanup EXIT

validate_inputs() {
  if [[ "$PROJECT" != "outputs-action" ]]; then
    fail "unsupported project for check-project-sync.sh: $PROJECT"
  fi

  if [[ -z "$SOURCE_PATH" || ! -d "$ROOT_DIR/$SOURCE_PATH" ]]; then
    fail "source path does not exist: $SOURCE_PATH"
  fi

  if [[ ! "$TARGET_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    fail "TARGET_REPOSITORY must look like owner/repo"
  fi

  if [[ "$ALLOW_BOOTSTRAP" != "true" && "$ALLOW_BOOTSTRAP" != "false" ]]; then
    fail "ALLOW_BOOTSTRAP must be true or false"
  fi
}

clone_public_repo() {
  local remote_url="https://github.com/${TARGET_REPOSITORY}.git"

  if [[ -n "$PUBLIC_TOKEN" ]]; then
    remote_url="https://x-access-token:${PUBLIC_TOKEN}@github.com/${TARGET_REPOSITORY}.git"
  fi

  echo "::group::Clone ${TARGET_REPOSITORY}"
  git clone --branch "$TARGET_BRANCH" --single-branch "$remote_url" "$PUBLIC_DIR" >/dev/null 2>&1
  echo "::endgroup::"
}

latest_sync_commit() {
  git -C "$PUBLIC_DIR" log --format=%H --grep="^sync outputs-action from monorepo " -n 1 HEAD
}

check_pending_public_commits() {
  local latest_sync="$1"
  local patch_file="$TMP_DIR/public.patch"
  local commit_log="$TMP_DIR/public-commits.txt"

  if [[ -z "$latest_sync" ]]; then
    if [[ "$ALLOW_BOOTSTRAP" == "true" ]]; then
      echo "no prior sync commit found in ${TARGET_REPOSITORY}; allowing bootstrap export"
      return
    fi

    fail "no prior sync commit found in ${TARGET_REPOSITORY}. Run Publish Outputs Action once to establish a sync baseline before merging more monorepo changes."
  fi

  git -C "$PUBLIC_DIR" log --format='%H %s' "${latest_sync}..HEAD" > "$commit_log"
  if [[ ! -s "$commit_log" ]]; then
    echo "no pending public-only commits"
    return
  fi

  git -C "$PUBLIC_DIR" diff --binary "$latest_sync" HEAD > "$patch_file"
  if [[ ! -s "$patch_file" ]]; then
    echo "no pending public-only diff"
    return
  fi

  if git -C "$ROOT_DIR" apply --check --reverse --directory="$SOURCE_PATH" "$patch_file" >/dev/null 2>&1; then
    echo "pending public-only commits are already present in monorepo content"
    return
  fi

  echo "public-only commits in ${TARGET_REPOSITORY}:${TARGET_BRANCH} are not yet present in ${SOURCE_PATH}:"
  cat "$commit_log"
  fail "import accepted public outputs-action changes before merging or exporting new monorepo changes"
}

main() {
  local latest_sync

  validate_inputs
  clone_public_repo

  echo "::group::Check sync state"
  latest_sync="$(latest_sync_commit)"
  check_pending_public_commits "$latest_sync"
  echo "::endgroup::"
}

main "$@"
