# Monorepo Publishing

This repo is the source of truth for the standalone `outputs-action` and `cli` repos.

## Published projects

- `actions/outputs-action` -> `yaffle-dot-dev/outputs-action`
- `packages/cli` -> `yaffle-dot-dev/cli`
- `demo` -> `yaffle-dot-dev/demo`

Both publishes are one-way. Maintainers should treat the standalone repos as mirrors, not places for primary development.

## How publish works

Each publish flow does the same sequence:

1. trigger from `main` when the relevant source path changes
2. split the subdirectory history with `git subtree split`
3. materialize standalone-only files in the split tree
4. validate the standalone tree
5. force-push the result to the configured target repo branch

The shared workflow entrypoint is `.github/workflows/publish-project.yml`. Thin wrappers live in:

- `.github/workflows/publish-outputs-action.yml`
- `.github/workflows/publish-cli.yml`

Shared publish logic lives in `scripts/publish-project.sh`.

## Standalone-only materialization

We do not symlink workflow files.

- Target repo CI workflows are generated from `publishing/templates/outputs-action/ci.yml` and `publishing/templates/cli/ci.yml`
- Target repo edge publish workflows are generated from `publishing/templates/outputs-action/edge.yml` and `publishing/templates/cli/edge.yml`
- The CLI standalone repo vendors `packages/yaffle-client/src/*` into `src/lib/yaffle-client/` during publish and rewrites imports so the public CLI repo is self-contained
- The CLI standalone repo also generates its own `bun.lock` during validation so its CI can use a frozen lockfile
- The CLI standalone repo also receives its own `flake.nix`, `flake.lock`, `nix/yaffle-cli.nix`, and release workflow so it can be packaged independently and attach binaries to GitHub releases

## Triggers

`publish-outputs-action.yml` runs for changes under:

- `actions/outputs-action/**`
- publish workflow plumbing
- `publishing/templates/outputs-action/**`

`publish-cli.yml` runs for changes under:

- `packages/cli/**`
- `packages/yaffle-client/**`
- publish workflow plumbing
- `publishing/templates/cli/**`

That extra `packages/yaffle-client/**` trigger matters because the public CLI repo materializes that code even though it is not stored under `packages/cli/` in the monorepo.

## Repo secrets

Configure these secrets in the source monorepo GitHub repo settings.

- secret `YAFFLE_INTERNAL_GH_APP_ID` -> the Yaffle internal GitHub App ID
- secret `YAFFLE_INTERNAL_GH_APP_PRIVATE_KEY` -> the PEM private key for that GitHub App

The reusable publish workflow uses `actions/create-github-app-token` to exchange those credentials for a short-lived installation token scoped to the target repo at runtime.

Requirements:

- the GitHub App must be installed on `yaffle-dot-dev/cli`
- the GitHub App must be installed on `yaffle-dot-dev/outputs-action`
- the installation must have `contents:write`

The shared publish script still supports a direct `PUBLISH_TOKEN` fallback, but the wired workflow configuration uses the GitHub App path.

## Credential rotation

To rotate publish credentials:

1. rotate the GitHub App private key in GitHub
2. update `YAFFLE_INTERNAL_GH_APP_PRIVATE_KEY` in the monorepo secrets
3. run the corresponding publish workflow manually with `dry_run: true`
4. rerun with `dry_run: false` once validation passes
5. revoke the old private key

To retarget a published repo later, update the hardcoded repo in the wrapper workflow and rotate the matching secret.

## Guardrails

The publish script fails if the standalone tree contains:

- symlinks
- obvious secret-like files
- env files, tfstate, dumps, or local databases
- unresolved CLI `@yaffle/client` imports
- remaining `workspace:` dependencies in the standalone CLI `package.json`
- missing required standalone files like `README.md`, `.gitignore`, or target-repo CI workflow files

Project validation also runs before push:

- `outputs-action`: `npm ci`, `npm run typecheck`, `npm run build`, and a committed `dist/index.js` freshness check
- `cli`: `bun install`, `bun run typecheck`, `bun test`, `bun run build`

## Tags and releases

Branch sync is automated. Tags are not mirrored automatically.

Recommended approach for now:

1. let the publish workflow sync `main` to the target repo
2. each standalone repo updates its rolling `edge` release after CI passes on `main`
3. create versioned tags and GitHub releases in the target repo when you want a stable cut
4. for the standalone CLI repo, publishing a versioned release triggers its generated release workflow to build and upload binaries

Do not assume a monorepo tag will appear in the standalone repos automatically.

This keeps monorepo publication, edge builds, and stable release asset production separate.

## Safe testing

Before pointing at a real public repo:

1. run the wrapper workflow with `workflow_dispatch` and `dry_run: true`
2. if you want a full push rehearsal, temporarily change the hardcoded target repo in the wrapper workflow to a scratch private repo
3. rerun with `dry_run: false`
4. inspect the published tree, generated CI workflow, edge workflow, and CLI vendored client
5. switch the wrapper workflow back to the real target repo before merging

## Known limitations

- force-push is intentional; the target branch is a publish artifact
- direct commits in the target repo will be overwritten on the next publish
- the public CLI repo contains generated vendored client code that must still be edited in the monorepo source package
- this setup does not currently create standalone repo tags or releases automatically
- stable semver tags still need to be created in the standalone repos when you want a durable release channel
- this repo still does not include per-project `LICENSE` files; add them under each published path before making the target repos formally open source
