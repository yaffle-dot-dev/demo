#!/usr/bin/env bash

set -euo pipefail

PROJECT="${PROJECT:-}"
SOURCE_PATH="${SOURCE_PATH:-}"
TARGET_REPOSITORY="${TARGET_REPOSITORY:-}"
TARGET_BRANCH="${TARGET_BRANCH:-main}"
PUSH_MODE="${PUSH_MODE:-force}"
PUBLISH_TOKEN="${PUBLISH_TOKEN:-}"
DRY_RUN="${DRY_RUN:-false}"

ROOT_DIR="$(git rev-parse --show-toplevel)"
TMP_DIR="$(mktemp -d)"
SPLIT_DIR="$TMP_DIR/split"
SPLIT_BRANCH="publish-${PROJECT}-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$"

fail() {
  printf '::error::%s\n' "$*" >&2
  exit 1
}

cleanup() {
  set +e
  git -C "$ROOT_DIR" worktree remove --force "$SPLIT_DIR" >/dev/null 2>&1 || true
  git -C "$ROOT_DIR" branch -D "$SPLIT_BRANCH" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}

trap cleanup EXIT

require_file() {
  local file_path="$1"
  if [[ ! -f "$file_path" ]]; then
    fail "missing required file: ${file_path#$SPLIT_DIR/}"
  fi
}

validate_inputs() {
  if [[ -z "$PROJECT" ]]; then
    fail "PROJECT is required"
  fi

  if [[ -z "$SOURCE_PATH" ]]; then
    fail "SOURCE_PATH is required"
  fi

  if [[ ! -d "$ROOT_DIR/$SOURCE_PATH" ]]; then
    fail "source path does not exist: $SOURCE_PATH"
  fi

  if [[ -z "$TARGET_REPOSITORY" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      TARGET_REPOSITORY="dry-run/${PROJECT}"
    else
      fail "TARGET_REPOSITORY is required"
    fi
  fi

  if [[ ! "$TARGET_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    fail "TARGET_REPOSITORY must look like owner/repo"
  fi

  if [[ "$PUSH_MODE" != "force" && "$PUSH_MODE" != "ff-only" ]]; then
    fail "PUSH_MODE must be force or ff-only"
  fi

  if [[ "$DRY_RUN" != "true" && -z "$PUBLISH_TOKEN" ]]; then
    fail "PUBLISH_TOKEN is required when DRY_RUN is false"
  fi
}

split_subtree() {
  echo "::group::Split ${SOURCE_PATH}"
  git -C "$ROOT_DIR" subtree split --prefix="$SOURCE_PATH" -b "$SPLIT_BRANCH" >/dev/null
  git -C "$ROOT_DIR" worktree add --detach "$SPLIT_DIR" "$SPLIT_BRANCH" >/dev/null
  echo "::endgroup::"
}

materialize_project() {
  case "$PROJECT" in
    outputs-action)
      :
      ;;
    cli)
      fail "cli now uses scripts/export-project.sh instead of subtree publish"
      ;;
    demo)
      :
      ;;
    *)
      fail "unsupported project: $PROJECT"
      ;;
  esac
}

validate_publish_tree() {
  echo "::group::Validate publish tree"

  require_file "$SPLIT_DIR/README.md"
  require_file "$SPLIT_DIR/LICENSE"
  require_file "$SPLIT_DIR/.gitignore"
  require_file "$SPLIT_DIR/.github/workflows/ci.yml"
  require_file "$SPLIT_DIR/.github/workflows/edge.yml"

  case "$PROJECT" in
    outputs-action|cli)
      require_file "$SPLIT_DIR/package.json"
      ;;
  esac

  case "$PROJECT" in
    outputs-action|demo)
      require_file "$SPLIT_DIR/CONTRIBUTING.md"
      require_file "$SPLIT_DIR/CODE_OF_CONDUCT.md"
      require_file "$SPLIT_DIR/SECURITY.md"
      ;;
  esac

  if find "$SPLIT_DIR" -path "$SPLIT_DIR/.git" -prune -o -type l -print | grep -q .; then
    fail "publish tree contains symlinks"
  fi

  while IFS= read -r file_path; do
    relative_path="${file_path#$SPLIT_DIR/}"
    case "$relative_path" in
      *.env|*.env.*|*.pem|*.p12|*.key|*.tfstate|*.tfstate.*|*.dump|*.bak|*.sqlite|*.db|node_modules/*|backups/*)
        fail "publish tree includes blocked file: $relative_path"
        ;;
      *credentials*.json|*secret*|*secrets*)
        fail "publish tree includes suspicious secret-like file: $relative_path"
        ;;
    esac
  done < <(find "$SPLIT_DIR" -path "$SPLIT_DIR/.git" -prune -o -type f -print)

  case "$PROJECT" in
    outputs-action)
      require_file "$SPLIT_DIR/action.yml"
      require_file "$SPLIT_DIR/dist/index.js"
      require_file "$SPLIT_DIR/package-lock.json"
      ;;
    cli)
      require_file "$SPLIT_DIR/tsconfig.json"
      require_file "$SPLIT_DIR/src/main.ts"
      require_file "$SPLIT_DIR/src/lib/yaffle-client/index.ts"
      require_file "$SPLIT_DIR/flake.nix"
      require_file "$SPLIT_DIR/flake.lock"
      require_file "$SPLIT_DIR/nix/yaffle-cli.nix"
      require_file "$SPLIT_DIR/.github/workflows/release.yml"

      if grep -R -n -E --exclude-dir=yaffle-client "from [\"']@yaffle/client[\"']" "$SPLIT_DIR/src" >/dev/null; then
        fail "standalone CLI still contains @yaffle/client imports"
      fi

      if grep -n 'workspace:' "$SPLIT_DIR/package.json" >/dev/null; then
        fail "standalone CLI package.json still contains workspace dependencies"
      fi
      ;;
    demo)
      require_file "$SPLIT_DIR/yaffle.toml"

      if [[ ! -d "$SPLIT_DIR/infra" ]]; then
        fail "standalone demo is missing infra/"
      fi
      ;;
  esac

  echo "::endgroup::"
}

validate_outputs_action_runtime() {
  echo "::group::Validate outputs-action"
  pushd "$SPLIT_DIR" >/dev/null

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

validate_cli_runtime() {
  echo "::group::Validate cli"
  pushd "$SPLIT_DIR" >/dev/null

  if ! command -v vp >/dev/null 2>&1; then
    fail "vp is required to validate the standalone CLI"
  fi

  vp install
  vp run typecheck
  vp test
  vp run build

  rm -rf node_modules dist
  popd >/dev/null
  echo "::endgroup::"
}

validate_runtime() {
  case "$PROJECT" in
    outputs-action)
      validate_outputs_action_runtime
      ;;
    cli)
      validate_cli_runtime
      ;;
    demo)
      echo "::group::Validate demo"
      if ! grep -q '^version = 1$' "$SPLIT_DIR/yaffle.toml"; then
        fail "demo yaffle.toml must declare version = 1"
      fi
      echo "::endgroup::"
      ;;
    *)
      fail "unsupported project: $PROJECT"
      ;;
  esac
}

commit_generated_tree() {
  if git -C "$SPLIT_DIR" diff --quiet && [[ -z "$(git -C "$SPLIT_DIR" status --short --untracked-files=normal)" ]]; then
    return
  fi

  git -C "$SPLIT_DIR" add -A

  GIT_AUTHOR_NAME="github-actions[bot]" \
  GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com" \
  GIT_COMMITTER_NAME="github-actions[bot]" \
  GIT_COMMITTER_EMAIL="41898282+github-actions[bot]@users.noreply.github.com" \
    git -C "$SPLIT_DIR" commit -m "publish ${PROJECT} from ${GITHUB_SHA:-local}" >/dev/null
}

push_tree() {
  local remote_url="https://x-access-token:${PUBLISH_TOKEN}@github.com/${TARGET_REPOSITORY}.git"
  local remote_ref

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "dry run complete for ${PROJECT} -> ${TARGET_REPOSITORY}:${TARGET_BRANCH}"
    return
  fi

  echo "::group::Push ${PROJECT}"
  git -C "$ROOT_DIR" config --local --unset-all http.https://github.com/.extraheader >/dev/null 2>&1 || true
  git -C "$SPLIT_DIR" remote add publish "$remote_url"

  if [[ "$PUSH_MODE" == "force" ]]; then
    git -C "$SPLIT_DIR" push --force publish "HEAD:refs/heads/${TARGET_BRANCH}"
    echo "::endgroup::"
    return
  fi

  remote_ref="refs/remotes/publish/${TARGET_BRANCH}"

  if ! git -C "$SPLIT_DIR" fetch publish "refs/heads/${TARGET_BRANCH}:${remote_ref}" >/dev/null 2>&1; then
    git -C "$SPLIT_DIR" push publish "HEAD:refs/heads/${TARGET_BRANCH}"
    echo "::endgroup::"
    return
  fi

  if git -C "$SPLIT_DIR" merge-base --is-ancestor "$remote_ref" HEAD; then
    git -C "$SPLIT_DIR" push publish "HEAD:refs/heads/${TARGET_BRANCH}"
    echo "::endgroup::"
    return
  fi

  if [[ "$(git -C "$SPLIT_DIR" rev-parse HEAD^{tree})" == "$(git -C "$SPLIT_DIR" rev-parse ${remote_ref}^{tree})" ]]; then
    echo "remote tree already matches local export; skipping push"
    echo "::endgroup::"
    return
  fi

  if remote_changes_are_already_in_local "$remote_ref"; then
    reconcile_remote_history "$remote_ref"
    git -C "$SPLIT_DIR" push publish "HEAD:refs/heads/${TARGET_BRANCH}"
    echo "::endgroup::"
    return
  fi

  fail "push was rejected for ${TARGET_REPOSITORY}:${TARGET_BRANCH}. Import upstream public changes into the monorepo first, then rerun publish."
  echo "::endgroup::"
}

remote_changes_are_already_in_local() {
  local remote_ref="$1"
  local merge_base patch_file

  merge_base="$(git -C "$SPLIT_DIR" merge-base HEAD "$remote_ref" 2>/dev/null || true)"
  if [[ -z "$merge_base" ]]; then
    return 1
  fi

  patch_file="$TMP_DIR/${PROJECT}-remote.patch"
  git -C "$SPLIT_DIR" diff --binary "$merge_base" "$remote_ref" > "$patch_file"

  if [[ ! -s "$patch_file" ]]; then
    return 0
  fi

  git -C "$SPLIT_DIR" apply --check --reverse "$patch_file" >/dev/null 2>&1
}

reconcile_remote_history() {
  local remote_ref="$1"

  echo "remote history diverged but its changes are already present locally; creating reconciliation merge"

  GIT_AUTHOR_NAME="github-actions[bot]" \
  GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com" \
  GIT_COMMITTER_NAME="github-actions[bot]" \
  GIT_COMMITTER_EMAIL="41898282+github-actions[bot]@users.noreply.github.com" \
    git -C "$SPLIT_DIR" merge --no-edit -s ours "$remote_ref" >/dev/null
}

main() {
  validate_inputs
  split_subtree
  materialize_project
  validate_publish_tree
  validate_runtime
  commit_generated_tree
  push_tree
}

main "$@"
