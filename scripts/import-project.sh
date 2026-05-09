#!/usr/bin/env bash

set -euo pipefail

PROJECT="${PROJECT:-}"
SOURCE_PATH="${SOURCE_PATH:-}"
SOURCE_REPOSITORY="${SOURCE_REPOSITORY:-}"
SOURCE_BRANCH="${SOURCE_BRANCH:-main}"
IMPORT_TOKEN="${IMPORT_TOKEN:-}"
MONOREPO_PUSH_TOKEN="${MONOREPO_PUSH_TOKEN:-}"
BRANCH_NAME="${BRANCH_NAME:-sync/import-${PROJECT}}"

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

require_file() {
  local root_dir="$1"
  local relative_path="$2"

  if [[ ! -f "$root_dir/$relative_path" ]]; then
    fail "missing required file: $relative_path"
  fi
}

validate_inputs() {
  if [[ "$PROJECT" != "outputs-action" && "$PROJECT" != "cli" ]]; then
    fail "unsupported project for import-project.sh: $PROJECT"
  fi

  if [[ -z "$SOURCE_PATH" || ! -d "$ROOT_DIR/$SOURCE_PATH" ]]; then
    fail "source path does not exist: $SOURCE_PATH"
  fi

  if [[ ! "$SOURCE_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    fail "SOURCE_REPOSITORY must look like owner/repo"
  fi

  if [[ -z "$IMPORT_TOKEN" ]]; then
    fail "IMPORT_TOKEN is required"
  fi

  if [[ -z "$MONOREPO_PUSH_TOKEN" ]]; then
    fail "MONOREPO_PUSH_TOKEN is required"
  fi
}

clone_public_repo() {
  local source_url="https://x-access-token:${IMPORT_TOKEN}@github.com/${SOURCE_REPOSITORY}.git"

  echo "::group::Clone ${SOURCE_REPOSITORY}"
  git clone --branch "$SOURCE_BRANCH" --single-branch "$source_url" "$PUBLIC_DIR" >/dev/null 2>&1
  echo "::endgroup::"
}

sync_public_tree_into_monorepo() {
  echo "::group::Sync public tree"
  rsync -a --delete \
    --exclude ".git" \
    --exclude ".git/" \
    "$PUBLIC_DIR/" "$ROOT_DIR/$SOURCE_PATH/"
  echo "::endgroup::"
}

validate_outputs_action_import() {
  local project_dir="$1"

  echo "::group::Validate imported outputs-action"

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

  pushd "$project_dir" >/dev/null
  npm ci
  npm run typecheck

  before="$(shasum dist/index.js | awk '{print $1}')"
  npm run build
  after="$(shasum dist/index.js | awk '{print $1}')"

  if [[ "$before" != "$after" ]]; then
    fail "imported outputs-action changed dist/index.js during build; update the public repo artifact before importing"
  fi

  rm -rf node_modules
  popd >/dev/null

  echo "::endgroup::"
}

validate_cli_import() {
  local project_dir="$1"

  echo "::group::Validate imported cli"

  require_file "$project_dir" "README.md"
  require_file "$project_dir" "LICENSE"
  require_file "$project_dir" ".gitignore"
  require_file "$project_dir" "package.json"
  require_file "$project_dir" "pnpm-lock.yaml"
  require_file "$project_dir" "tsconfig.json"
  require_file "$project_dir" "flake.nix"
  require_file "$project_dir" "flake.lock"
  require_file "$project_dir" "nix/yaffle-cli.nix"
  require_file "$project_dir" "src/main.ts"
  require_file "$project_dir" "src/client.ts"
  require_file "$project_dir" "src/lib/yaffle-client/index.ts"
  require_file "$project_dir" ".github/workflows/ci.yml"
  require_file "$project_dir" ".github/workflows/edge.yml"
  require_file "$project_dir" ".github/workflows/release.yml"
  require_file "$project_dir" "CONTRIBUTING.md"
  require_file "$project_dir" "CODE_OF_CONDUCT.md"
  require_file "$project_dir" "SECURITY.md"

  if grep -R -n -E "from [\"']@yaffle/client[\"']" "$project_dir/src" >/dev/null; then
    fail "imported CLI still contains @yaffle/client imports"
  fi

  if grep -n 'workspace:' "$project_dir/package.json" >/dev/null; then
    fail "imported CLI package.json still contains workspace dependencies"
  fi

  pushd "$project_dir" >/dev/null
  vp install --frozen-lockfile
  vp run typecheck
  vp test
  vp run build
  rm -rf node_modules dist
  popd >/dev/null

  echo "::endgroup::"
}

validate_import() {
  local project_dir="$1"

  case "$PROJECT" in
    outputs-action)
      validate_outputs_action_import "$project_dir"
      ;;
    cli)
      validate_cli_import "$project_dir"
      ;;
    *)
      fail "unsupported project for import validation: $PROJECT"
      ;;
  esac
}

commit_and_push() {
  local source_sha="$1"
  local monorepo_url="https://x-access-token:${MONOREPO_PUSH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"

  if git -C "$ROOT_DIR" diff --quiet -- "$SOURCE_PATH" && [[ -z "$(git -C "$ROOT_DIR" status --short -- "$SOURCE_PATH")" ]]; then
    echo "changed=false" >> "$GITHUB_OUTPUT"
    echo "branch_name=$BRANCH_NAME" >> "$GITHUB_OUTPUT"
    echo "source_sha=$source_sha" >> "$GITHUB_OUTPUT"
    return
  fi

  validate_import "$PUBLIC_DIR"

  git -C "$ROOT_DIR" config --local --unset-all http.https://github.com/.extraheader >/dev/null 2>&1 || true
  git -C "$ROOT_DIR" config user.name "github-actions[bot]"
  git -C "$ROOT_DIR" config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git -C "$ROOT_DIR" add "$SOURCE_PATH"
  git -C "$ROOT_DIR" commit -m "sync ${PROJECT} from ${SOURCE_REPOSITORY}@${source_sha}" >/dev/null
  git -C "$ROOT_DIR" push --force-with-lease "$monorepo_url" "HEAD:refs/heads/${BRANCH_NAME}"

  echo "changed=true" >> "$GITHUB_OUTPUT"
  echo "branch_name=$BRANCH_NAME" >> "$GITHUB_OUTPUT"
  echo "source_sha=$source_sha" >> "$GITHUB_OUTPUT"
}

main() {
  local source_sha

  validate_inputs
  git -C "$ROOT_DIR" switch -C "$BRANCH_NAME"
  clone_public_repo
  source_sha="$(git -C "$PUBLIC_DIR" rev-parse HEAD)"
  sync_public_tree_into_monorepo
  commit_and_push "$source_sha"
}

main "$@"
