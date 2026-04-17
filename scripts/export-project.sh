#!/usr/bin/env bash

set -euo pipefail

PROJECT="${PROJECT:-}"
SOURCE_PATH="${SOURCE_PATH:-}"
TARGET_REPOSITORY="${TARGET_REPOSITORY:-}"
TARGET_BRANCH="${TARGET_BRANCH:-main}"
PUBLISH_TOKEN="${PUBLISH_TOKEN:-}"
DRY_RUN="${DRY_RUN:-false}"

ROOT_DIR="$(git rev-parse --show-toplevel)"
TMP_DIR="$(mktemp -d)"
TARGET_DIR="$TMP_DIR/target"

fail() {
  printf '::error::%s\n' "$*" >&2
  exit 1
}

cleanup() {
  rm -rf "$TMP_DIR"
}

trap cleanup EXIT

require_file() {
  local root_dir="$1"
  local relative_path="$2"

  if [[ ! -f "$root_dir/$relative_path" ]]; then
    fail "missing required file: $relative_path"
  fi
}

validate_inputs() {
  if [[ "$PROJECT" != "outputs-action" ]]; then
    fail "unsupported project for export-project.sh: $PROJECT"
  fi

  if [[ -z "$SOURCE_PATH" || ! -d "$ROOT_DIR/$SOURCE_PATH" ]]; then
    fail "source path does not exist: $SOURCE_PATH"
  fi

  if [[ ! "$TARGET_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    fail "TARGET_REPOSITORY must look like owner/repo"
  fi

  if [[ "$DRY_RUN" != "true" && -z "$PUBLISH_TOKEN" ]]; then
    fail "PUBLISH_TOKEN is required when DRY_RUN is false"
  fi
}

clone_target_repo() {
  local remote_url="https://x-access-token:${PUBLISH_TOKEN}@github.com/${TARGET_REPOSITORY}.git"

  if [[ "$DRY_RUN" == "true" ]]; then
    remote_url="https://github.com/${TARGET_REPOSITORY}.git"
  fi

  echo "::group::Clone ${TARGET_REPOSITORY}"
  git clone --branch "$TARGET_BRANCH" --single-branch "$remote_url" "$TARGET_DIR" >/dev/null 2>&1
  echo "::endgroup::"
}

sync_tree() {
  echo "::group::Sync tree"
  rsync -a --delete \
    --exclude ".git" \
    --exclude ".git/" \
    "$ROOT_DIR/$SOURCE_PATH/" "$TARGET_DIR/"
  echo "::endgroup::"
}

validate_outputs_action_tree() {
  local project_dir="$1"

  echo "::group::Validate outputs-action"

  require_file "$project_dir" "README.md"
  require_file "$project_dir" "LICENSE"
  require_file "$project_dir" ".gitignore"
  require_file "$project_dir" "package.json"
  require_file "$project_dir" "package-lock.json"
  require_file "$project_dir" "action.yml"
  require_file "$project_dir" "dist/index.js"
  require_file "$project_dir" ".github/workflows/ci.yml"
  require_file "$project_dir" ".github/workflows/edge.yml"
  require_file "$project_dir" "CONTRIBUTING.md"
  require_file "$project_dir" "CODE_OF_CONDUCT.md"
  require_file "$project_dir" "SECURITY.md"

  if find "$project_dir" -path "$project_dir/.git" -prune -o -type l -print | grep -q .; then
    fail "publish tree contains symlinks"
  fi

  while IFS= read -r file_path; do
    local relative_path="${file_path#$project_dir/}"
    case "$relative_path" in
      *.env|*.env.*|*.pem|*.p12|*.key|*.tfstate|*.tfstate.*|*.dump|*.bak|*.sqlite|*.db|node_modules/*|backups/*)
        fail "publish tree includes blocked file: $relative_path"
        ;;
      *credentials*.json|*secret*|*secrets*)
        fail "publish tree includes suspicious secret-like file: $relative_path"
        ;;
    esac
  done < <(find "$project_dir" -path "$project_dir/.git" -prune -o -type f -print)

  pushd "$project_dir" >/dev/null
  npm ci
  npm run typecheck

  before="$(shasum dist/index.js | awk '{print $1}')"
  npm run build
  after="$(shasum dist/index.js | awk '{print $1}')"

  if [[ "$before" != "$after" ]]; then
    fail "dist/index.js changed during build; commit the rebuilt artifact in $SOURCE_PATH"
  fi

  rm -rf node_modules
  popd >/dev/null

  echo "::endgroup::"
}

commit_and_push() {
  if git -C "$TARGET_DIR" diff --quiet && [[ -z "$(git -C "$TARGET_DIR" status --short --untracked-files=normal)" ]]; then
    echo "target repository already matches monorepo tree"
    return
  fi

  git -C "$ROOT_DIR" config --local --unset-all http.https://github.com/.extraheader >/dev/null 2>&1 || true

  git -C "$TARGET_DIR" add -A
  GIT_AUTHOR_NAME="github-actions[bot]" \
  GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com" \
  GIT_COMMITTER_NAME="github-actions[bot]" \
  GIT_COMMITTER_EMAIL="41898282+github-actions[bot]@users.noreply.github.com" \
    git -C "$TARGET_DIR" commit -m "sync outputs-action from monorepo ${GITHUB_SHA:-local}" >/dev/null

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "dry run complete for ${PROJECT} -> ${TARGET_REPOSITORY}:${TARGET_BRANCH}"
    return
  fi

  echo "::group::Push ${TARGET_REPOSITORY}"
  git -C "$TARGET_DIR" push origin "HEAD:refs/heads/${TARGET_BRANCH}"
  echo "::endgroup::"
}

main() {
  validate_inputs
  clone_target_repo
  PROJECT="$PROJECT" \
  SOURCE_PATH="$SOURCE_PATH" \
  TARGET_REPOSITORY="$TARGET_REPOSITORY" \
  TARGET_BRANCH="$TARGET_BRANCH" \
  PUBLIC_TOKEN="$PUBLISH_TOKEN" \
  ALLOW_BOOTSTRAP="true" \
    bash "$ROOT_DIR/scripts/check-project-sync.sh"
  sync_tree
  validate_outputs_action_tree "$TARGET_DIR"
  commit_and_push
}

main "$@"
