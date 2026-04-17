# Monorepo Publishing

This repo is the integration home for the published `outputs-action`, `cli`, and `demo` repos.

## Published projects

- `actions/outputs-action` -> `yaffle-dot-dev/outputs-action`
- `packages/cli` -> `yaffle-dot-dev/cli`
- `demo` -> `yaffle-dot-dev/demo`

Current sync model:

- `actions/outputs-action`: tree-sync bidirectional; public repo accepts community PRs
- `demo`: one-way publish; public repo is a published example repo
- `packages/cli`: monorepo-first publish for now; public repo shape is still partly materialized during publish

## How publish works

Current export models:

1. `actions/outputs-action` uses direct tree-sync export to `yaffle-dot-dev/outputs-action`
2. `packages/cli` and `demo` still use subtree-based publish flows

For subtree-based publish flows, each export does the same sequence:

1. trigger from `main` when the relevant source path changes
2. split the subdirectory history with `git subtree split`
3. materialize standalone-only files in the split tree when needed
4. validate the standalone tree
5. push the result to the configured target repo branch

The shared subtree-publish entrypoint is `.github/workflows/publish-project.yml`. Thin wrappers live in:

- `.github/workflows/publish-outputs-action.yml`
- `.github/workflows/publish-cli.yml`
- `.github/workflows/publish-demo.yml`

Shared subtree publish logic lives in `scripts/publish-project.sh`.

`actions/outputs-action` uses dedicated tree-sync scripts:

- export: `scripts/export-project.sh`
- import: `scripts/import-project.sh`
- guard: `scripts/check-project-sync.sh`

## Standalone-only materialization

We do not symlink workflow files.

- `actions/outputs-action` keeps its standalone repo files directly under its own path in the monorepo, including `.github/workflows/*` and community docs, so public contributions can sync back cleanly as file-tree updates
- `demo` also keeps its standalone repo files directly under `demo/`, but it is treated as a one-way published example repo
- The CLI standalone repo vendors `packages/yaffle-client/src/*` into `src/lib/yaffle-client/` during publish and rewrites imports so the public CLI repo is self-contained
- The CLI standalone repo also generates its own `bun.lock` during validation so its CI can use a frozen lockfile
- The CLI standalone repo also receives its own `flake.nix`, `flake.lock`, `nix/yaffle-cli.nix`, and release workflow so it can be packaged independently and attach binaries to GitHub releases

## Triggers

`publish-outputs-action.yml` runs for changes under:

- `actions/outputs-action/**`
- publish workflow plumbing

`publish-cli.yml` runs for changes under:

- `packages/cli/**`
- `packages/yaffle-client/**`
- publish workflow plumbing
- `publishing/templates/cli/**`

That extra `packages/yaffle-client/**` trigger matters because the public CLI repo materializes that code even though it is not stored under `packages/cli/` in the monorepo.

`publish-demo.yml` runs for changes under:

- `demo/**`
- publish workflow plumbing

## Repo secrets

Configure these secrets in the source monorepo GitHub repo settings.

- secret `YAFFLE_INTERNAL_GH_APP_ID` -> the Yaffle internal GitHub App ID
- secret `YAFFLE_INTERNAL_GH_APP_PRIVATE_KEY` -> the PEM private key for that GitHub App

The reusable publish workflow uses `actions/create-github-app-token` to exchange those credentials for a short-lived installation token scoped to the target repo at runtime.

Requirements:

- the GitHub App must be installed on `yaffle-dot-dev/cli`
- the GitHub App must be installed on `yaffle-dot-dev/outputs-action`
- the GitHub App must be installed on `yaffle-dot-dev/demo`
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

For `actions/outputs-action`, export clones the public repo, replaces its working tree with the monorepo path contents, validates the result, creates a normal sync commit on top of public `main`, and pushes it directly. This avoids subtree ancestry drift.

That also means maintainers must import accepted public changes back into the monorepo before merging new internal changes for `outputs-action`. The monorepo sync-check workflow is there to enforce that before merge so the next export cannot silently overwrite public-only changes.

To protect against that, `.github/workflows/check-outputs-action-sync.yml` runs on monorepo PRs that touch `actions/outputs-action/**`. It fails if the public repo contains accepted changes that are not yet present in the monorepo content.

Project validation also runs before push:

- `outputs-action`: `npm ci`, `npm run typecheck`, `npm run build`, and a committed `dist/index.js` freshness check
- `cli`: `bun install`, `bun run typecheck`, `bun test`, `bun run build`
- `demo`: structural validation for `yaffle.toml` and `infra/`

## Public contributions

The intended workflow is:

1. Yaffle maintainers work primarily in the monorepo
2. exports publish those changes to the public repo
3. community PRs land in writable public repos like `outputs-action`
4. maintainers run `Import Public Project` to sync the public repo tree back into the monorepo path on a stable PR branch
5. later exports push a new sync commit from the updated monorepo state

This avoids overwriting accepted public contributions while keeping the monorepo as the integration home.

The import workflow reuses a stable branch (`sync/import-outputs-action`) so repeated imports update the same PR instead of opening duplicates.

The first direct export commit can also serve as a one-time normalization/reset of the public repo tree if its historical content drifted from the monorepo.

## Tags and releases

Branch sync is automated. Tags are not mirrored automatically.

Recommended approach for now:

1. let the export workflow sync `main` to the target repo
2. each standalone repo updates its rolling `edge` release after CI passes on `main`
3. create versioned tags and GitHub releases in the target repo when you want a stable cut
4. for the standalone CLI repo, publishing a versioned release triggers its generated release workflow to build and upload binaries

Do not assume a monorepo tag will appear in the standalone repos automatically.

This keeps monorepo export, public import, edge builds, and stable release asset production separate.

## Safe testing

Before pointing at a real public repo:

1. run the wrapper workflow with `workflow_dispatch` and `dry_run: true`
2. if you want a full push rehearsal, temporarily change the hardcoded target repo in the wrapper workflow to a scratch private repo
3. rerun with `dry_run: false`
4. inspect the published tree, root workflows, edge workflow, and CLI vendored client
5. switch the wrapper workflow back to the real target repo before merging

## Known limitations

- `outputs-action` tree-sync import/export preserves public repo usability, but monorepo commits remain bot-authored sync commits rather than replayed public git history
- `demo` is intentionally one-way and exported with force push semantics
- the public CLI repo contains generated vendored client code that must still be edited in the monorepo source package
- the CLI repo is not yet ready for clean bidirectional subtree sync because its standalone repo shape is still partly generated at publish time
- this setup does not currently create standalone repo tags or releases automatically
- stable semver tags still need to be created in the standalone repos when you want a durable release channel
