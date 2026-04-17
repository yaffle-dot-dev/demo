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

copy_target_workflows() {
  mkdir -p "$SPLIT_DIR/.github/workflows"

  local workflow_template
  for workflow_template in "$ROOT_DIR/publishing/templates/$PROJECT"/*.yml; do
    if [[ -f "$workflow_template" ]]; then
      cp "$workflow_template" "$SPLIT_DIR/.github/workflows/$(basename "$workflow_template")"
    fi
  done
}

update_package_json() {
  local project_dir="$1"
  local project_name="$2"
  local target_repo="$3"

  node - "$ROOT_DIR" "$project_dir" "$project_name" "$target_repo" <<'JS'
const fs = require("node:fs")
const path = require("node:path")

const [, , rootDir, projectDir, projectName, targetRepo] = process.argv

const packagePath = path.join(projectDir, "package.json")
const packageData = JSON.parse(fs.readFileSync(packagePath, "utf8"))
packageData.repository = {
  type: "git",
  url: `git+https://github.com/${targetRepo}.git`,
}
packageData.homepage = `https://github.com/${targetRepo}`
packageData.bugs = {
  url: `https://github.com/${targetRepo}/issues`,
}

if (projectName === "cli") {
  const clientPackagePath = path.join(rootDir, "packages", "yaffle-client", "package.json")
  const clientPackage = JSON.parse(fs.readFileSync(clientPackagePath, "utf8"))
  const eventsourceVersion = clientPackage.dependencies?.eventsource
  if (!eventsourceVersion) {
    throw new Error("missing eventsource dependency version in packages/yaffle-client/package.json")
  }

  packageData.dependencies = packageData.dependencies ?? {}
  delete packageData.dependencies["@yaffle/client"]
  packageData.dependencies.eventsource = eventsourceVersion
}

fs.writeFileSync(packagePath, `${JSON.stringify(packageData, null, 2)}\n`)
JS
}

rewrite_cli_imports() {
  node - "$SPLIT_DIR" <<'JS'
const fs = require("node:fs")
const path = require("node:path")

const [, , projectDir] = process.argv
const srcDir = path.join(projectDir, "src")
const vendorIndex = path.join(srcDir, "lib", "yaffle-client", "index.js")

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const nextPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(nextPath)
      continue
    }

    if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name)) {
      continue
    }

    const text = fs.readFileSync(nextPath, "utf8")
    if (!text.includes("@yaffle/client")) {
      continue
    }

    let relativeImport = path.relative(path.dirname(nextPath), vendorIndex).split(path.sep).join("/")
    if (!relativeImport.startsWith(".")) {
      relativeImport = `./${relativeImport}`
    }

    fs.writeFileSync(nextPath, text.replaceAll("@yaffle/client", relativeImport))
  }
}

walk(srcDir)
JS
}

materialize_outputs_action() {
  copy_target_workflows
  update_package_json "$SPLIT_DIR" "$PROJECT" "$TARGET_REPOSITORY"
}

materialize_cli() {
  copy_target_workflows

  rm -rf "$SPLIT_DIR/src/lib/yaffle-client"
  mkdir -p "$SPLIT_DIR/src/lib/yaffle-client"
  mkdir -p "$SPLIT_DIR/nix"
  cp "$ROOT_DIR"/packages/yaffle-client/src/*.ts "$SPLIT_DIR/src/lib/yaffle-client/"
  cp "$ROOT_DIR/publishing/templates/cli/flake.nix" "$SPLIT_DIR/flake.nix"
  cp "$ROOT_DIR/flake.lock" "$SPLIT_DIR/flake.lock"
  cp "$ROOT_DIR/publishing/templates/cli/nix/yaffle-cli.nix" "$SPLIT_DIR/nix/yaffle-cli.nix"

  rewrite_cli_imports
  update_package_json "$SPLIT_DIR" "$PROJECT" "$TARGET_REPOSITORY"
}

materialize_project() {
  case "$PROJECT" in
    outputs-action)
      materialize_outputs_action
      ;;
    cli)
      materialize_cli
      ;;
    demo)
      copy_target_workflows
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

  if ! command -v bun >/dev/null 2>&1; then
    fail "bun is required to validate the standalone CLI"
  fi

  bun install
  bun run typecheck
  bun test
  bun run build

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

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "dry run complete for ${PROJECT} -> ${TARGET_REPOSITORY}:${TARGET_BRANCH}"
    return
  fi

  echo "::group::Push ${PROJECT}"
  git -C "$ROOT_DIR" config --local --unset-all http.https://github.com/.extraheader >/dev/null 2>&1 || true
  git -C "$SPLIT_DIR" remote add publish "$remote_url"
  git -C "$SPLIT_DIR" push --force publish "HEAD:refs/heads/${TARGET_BRANCH}"
  echo "::endgroup::"
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
