---
description: Republish the npm packages (nim CLI + wiki-web, or the extension SDK) whose source changed since their last publish
argument-hint: "[cli|sdk] [patch|minor|major|X.Y.Z] [--check]"
allowed-tools: Bash, Read, Edit, mcp__nimbalyst__AskUserQuestion, mcp__nimbalyst__developer_git_commit_proposal
---

Publish the npm packages this repo ships, but only the ones whose source changed since their last publish. Publishing runs in GitHub Actions with npm Trusted Publishing; this command checks, bumps, commits and dispatches. It never publishes from this machine and never uses an npm token.

| Group | Packages (one shared version) | Workflow |
| --- | --- | --- |
| `cli` | `@nimbalyst/cli` (`nim`) and `@nimbalyst/wiki-web` (the `nim wiki serve` browser app) | `publish-cli.yml` |
| `sdk` | `@nimbalyst/extension-sdk` | `publish-extension-sdk.yml` |

Arguments: `$ARGUMENTS`. A group name limits the run to that group. A bump (`patch`, the default, `minor`, `major`, or an exact `X.Y.Z`) sets the new version. `--check` reports and stops.

Run `npm` only from outside this repo (`cd "$(mktemp -d)"` or `--prefix` does not help): the root `package.json` declares pnpm in `devEngines`, so every `npm` command inside the checkout fails with `EBADDEVENGINES`.

## 1. Find what changed

```bash
node scripts/npm-publish-status.mjs [cli|sdk]
```

For each group it compares the local version with npm and lists the commits and uncommitted files since the last publish that touch what the packages are built from. Show the report. Statuses:

- **up to date**: nothing to do for that group.
- **bump+publish**: published, and the source changed since. Bump, then publish.
- **publish (already bumped)**: the local version is ahead of npm. Skip the bump.
- **never published**: the first version must be published by hand before Trusted Publishing can be configured. See step 7.
- **VERSIONS DIFFER** (cli group): `packages/cli` and `packages/wiki-web` must share one version. Fix that as part of the bump.
- **LOCAL BEHIND NPM**: stop and tell the user; never publish over a newer version.

A baseline "estimated" from the publish time can be off by a commit (a hand publish records no commit). The cli group's watch list includes collab-client and the runtime editor, which reach wiki-web through the prebuilt collab-bundle, so it can over-report. Read the commit subjects and say if a group's changes look unrelated to what ships.

If every group is up to date, say so and stop. With `--check`, stop here.

## 2. Gate on uncommitted and unpushed work

- **Uncommitted watched files**: do not publish that group. They are often another session's work. List them and ask (AskUserQuestion): wait until they are committed, or skip the group.
- **Branch and push state**: the workflow builds what is on the remote branch, not this checkout. Run `git fetch origin && git status -sb`. Publish from `main`. If local commits are not on `origin/main`, ask before pushing; the pre-push hook runs the test gate. Never force-push.

## 3. Bump and commit (bump+publish only)

Show the current and new version and confirm with AskUserQuestion before editing.

- **cli**: set the same `version` in `packages/cli/package.json` and `packages/wiki-web/package.json`. `nim --version` comes from the CLI's package.json at build time; nothing else needs bumping.
- **sdk**: set `version` in `packages/extension-sdk/package.json`, add a section to `packages/extension-sdk/CHANGELOG.md` (what an extension author can now do, one line per change, from the commits in step 1), and add a row to its version table. Ask for the minimum app version if `nimbalyst.minAppVersion` should change.

No entry in the root `CHANGELOG.md`: these packages release independently of the app.

Commit only those files with `mcp__nimbalyst__developer_git_commit_proposal`, message `chore: release @nimbalyst/cli and @nimbalyst/wiki-web X.Y.Z` (or `chore: release @nimbalyst/extension-sdk X.Y.Z`). Then push, after asking, as in step 2.

Never create a `cli-v*` or `sdk-v*` git tag. The workflows are manual for that reason: a stray tag at the top of the repo's releases feed breaks the desktop app's update check.

## 4. Check locally before dispatching

Cheaper than a failed workflow run. For **cli**:

```bash
pnpm --filter @nimbalyst/cli run typecheck && pnpm --filter @nimbalyst/cli run test
pnpm --filter @nimbalyst/wiki-web run build      # ends with its size budget check
node scripts/build-wiki-plugin.mjs --check       # the Claude Code plugin bundles nim mcp; it must match
```

If the plugin check reports stale, run `pnpm build:wiki-plugin` and commit the result before publishing, so the plugin and the published CLI carry the same server.

For **sdk**: `pnpm --filter @nimbalyst/extension-sdk run build`.

## 5. Dry run in CI

```bash
gh workflow run <workflow> --ref main -f version=X.Y.Z -f dry_run=true
sleep 5
RUN_ID=$(gh run list --workflow=<workflow> --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status
```

Run the watch in the background and wait for it to finish. The cli dry run builds both packages, checks the wiki-web size budget, and smoke-tests the packed tarballs, including `nim wiki`, `nim mcp` and `nim wiki serve` installed without better-sqlite3. On failure, read `gh run view "$RUN_ID" --log-failed`, report the failing step, and stop.

## 6. Publish

Ask the user to confirm (AskUserQuestion: publish X.Y.Z to npm, or stop). Publishing is public and a version can never be reused. Then:

```bash
gh workflow run <workflow> --ref main -f version=X.Y.Z -f dry_run=false
```

Watch it the same way. The cli workflow publishes wiki-web first, because `nim` tells users to install `@nimbalyst/wiki-web@<its own version>`, and skips any version already on npm, so a run that failed halfway can simply be re-run.

## 7. Verify and report

From outside the repo:

```bash
cd "$(mktemp -d)"
npm view @nimbalyst/cli@X.Y.Z version && npm view @nimbalyst/wiki-web@X.Y.Z version
npx -y @nimbalyst/cli@X.Y.Z --version
```

The registry can take a minute to serve a new version. Report the version, the run URL, and the npm links (`https://www.npmjs.com/package/<name>/v/X.Y.Z`).

**First publish, or an OIDC failure** (`ENEEDAUTH`, `404` on publish, "no trusted publisher"): Trusted Publishing must be configured on npmjs.com for each package, naming this repository, the workflow file and the `npm-publish` environment. A package that has never been published needs its first version published by hand before that is possible. That is the one step the user runs, because it needs their npm login and one-time password: build and pack as in step 4, then `npm publish <tarball> --access public` from outside the repo. Never add an npm token to the repository or the workflow as a workaround.
