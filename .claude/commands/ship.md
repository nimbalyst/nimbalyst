---
description: Report and ship every server, npm package, plugin and marketplace artifact that changed since its last release
argument-hint: "[collab|npm|plugins|wiki|marketplace ...] [--check]"
allowed-tools: Bash, Read, Edit, mcp__nimbalyst__AskUserQuestion, mcp__nimbalyst__PromptForUserInput, mcp__nimbalyst__developer_git_commit_proposal
---

Find everything Nimbalyst ships outside the desktop app that has changed since its last release, then ship it in dependency order. Each target keeps its own procedure; this command decides what is due, orders it, and runs those procedures.

Arguments: `$ARGUMENTS`. Area names limit the run (`collab`, `npm`, `plugins`, `marketplace`); `wiki` is an alias for `plugins`. With no area argument, inventory every target below, including Claude Code and Codex plugins. Do not silently narrow the inventory to npm or to the feature discussed earlier. `--check` reports and stops.

| Area | Target | Published to | Status command (run from) | Procedure |
| --- | --- | --- | --- | --- |
| collab | collabv3 | sync.nimbalyst.com | `node scripts/deploy-changes.mjs` (nimbalyst-collab) | [/deploy-collab](./deploy-collab.md) |
| collab | web-console | Cloudflare Pages | same | same |
| collab | collabv3-metrics | nimbalyst-collabv3-metrics.pages.dev | same | same |
| npm | `@nimbalyst/cli` + `@nimbalyst/wiki-web` | npm, via `publish-cli.yml` | `node scripts/npm-publish-status.mjs` | [/publish-npm](./publish-npm.md) `cli` |
| npm | `@nimbalyst/extension-sdk` | npm, via `publish-extension-sdk.yml` | same | [/publish-npm](./publish-npm.md) `sdk` |
| plugins / wiki | `nimbalyst-wiki` for Claude Code and Codex | `nimbalyst/nimbalyst-wiki`; the `nimbalyst` marketplace points to this mirror | `node scripts/wiki-mirror-status.mjs` | step 4 below |
| plugins / wiki | `nimbalyst-wiki-team` add-on for Claude Code and Codex | `nimbalyst/nimbalyst-wiki`, under `nimbalyst-wiki-team/` | same (released with the wiki plugin) | step 4 below |
| marketplace | Marketplace Worker | extensions.nimbalyst.com | `node packages/marketplace/scripts/worker-status.mjs` | step 5 below |
| marketplace | Marketplace extensions | R2 CDN registry | `pnpm run marketplace:status` | [/release-extension](./release-extension.md) |

Out of scope: the desktop app (`/release-alpha`), iOS and Android, and the hand-written extensions list in the `nimbalyst-website` repo. If an extension ships to the marketplace for the first time, tell the user that list needs a manual entry.

## 1. Report

Run `git fetch origin && git status -sb` here, then every status command for the requested areas. They are independent, so run them in parallel. Show one table: target, status, and a short reason (the commit subjects that matter, not the full lists). Then add the notes that change a decision:

- **Unpushed commits on `main`.** The npm workflows build `origin/main`. Check `.claude-plugin/marketplace.json` and `scripts/wiki-repo/.claude-plugin/marketplace.json` for the actual plugin install sources. A monorepo push does not publish plugins whose marketplace source is the mirror; that repository must be staged, committed and pushed too.
- **Plugin coverage.** Enumerate every plugin in those marketplace manifests, including add-ons, and report both Claude Code and Codex manifests where present. If a new plugin has no status command or release procedure, report that gap explicitly instead of silently omitting it.
- **Uncommitted watched files** in any report: that target does not ship until they are committed. They are often another session's work.
- **Over-reporting.** The collab, cli and wiki reports watch collab-bundle's inputs broadly, and package.json edits count as changes for the Worker. Read the commit subjects, and say when a target's changes do not reach what it ships (a desktop-only fix in `runtime/src/editor`, a scripts-only package.json edit).
- **Estimated baselines** (marked in the reports) can be off by a commit.

If nothing is due, say so and stop. With `--check`, stop here.

## 2. Choose and prepare

Ask with PromptForUserInput: a multiSelect of the due targets, pre-checked, minus any you flagged as over-reported. Then do every monorepo change the chosen targets need before anything deploys, so a single push covers them:

- npm version bumps ([/publish-npm](./publish-npm.md) step 3).
- The wiki plugin version bump when its status is `bump+stage`. Keep the CLI, wiki-web and all four plugin manifests at the same version: `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` under both `plugins/nimbalyst-wiki` and `plugins/nimbalyst-wiki-team`. If the new pinned CLI version is not published, include the npm CLI group as a dependency of this release.
- Then, after every bump above, run `node scripts/build-wiki-plugin.mjs --check`. If it reports stale, run `pnpm build:wiki-plugin` and include the result. Generated MCP configs and hooks pin the CLI version from `packages/cli/package.json`, so regeneration before the CLI bump leaves the old version pinned and the pre-push gate refuses the push.

Commit these together with `mcp__nimbalyst__developer_git_commit_proposal` (`chore: release @nimbalyst/cli and @nimbalyst/wiki-web X.Y.Z`, or `chore: release Nimbalyst Wiki X.Y.Z` when only the plugin moved).

If `main` has unpushed commits, ask before `git push origin main`. The pre-push hook runs the test gate. Never force-push.

## 3. Ship, in this order

Later steps depend on earlier ones: the console, metrics, plugin and `nim` call collabv3 endpoints, and the wiki plugin pins the CLI package, which depends on the matching wiki-web package.

1. **collabv3**, then **web-console** and **collabv3-metrics**: [/deploy-collab](./deploy-collab.md) from step 2 on.
2. **Marketplace Worker**: step 5.
3. **npm**: [/publish-npm](./publish-npm.md) from step 4 on, `sdk` and `cli` independently.
4. **Claude Code and Codex plugins**, including the wiki team add-on: step 4 below.
5. **Marketplace extensions**: [/release-extension](./release-extension.md) for each chosen extension.

Stop the chain at a failed step, unless the remaining targets do not depend on it (an extension release does not depend on the Worker deploy).

## 4. Claude Code and Codex plugins

`nimbalyst/nimbalyst-wiki` is generated output; never edit it by hand. The local clone is `../nimbalyst-wiki`.

1. The clone must be on `main`, clean, and current: `git -C ../nimbalyst-wiki status -sb`, then `git -C ../nimbalyst-wiki pull --ff-only`. If it has local changes, stop and ask.
2. Run `node scripts/stage-wiki-repo.mjs ../nimbalyst-wiki`. This stages both wiki plugins and both providers' manifests. The plugin runs `@nimbalyst/cli` at its own version, so publish the cli group first ([/publish-npm](./publish-npm.md)). Staging refuses a stale plugin, a changed plugin without a version bump, a plugin whose pinned CLI is not installable yet, and anything the Anthropic plugin directory would block or hold for a reviewer. A successful npm workflow is not sufficient: from outside the monorepo, `npx -y --prefer-online @nimbalyst/cli@X.Y.Z --version` must print the version. If npm is still processing the package, keep plugin publication pending and retry availability before staging; do not bump again or bypass the npm check. On resuming an interrupted ship, finish these pending plugin steps instead of republishing npm. For other staging failures, return to preparation.
3. Read `../nimbalyst-wiki/SOURCE`. If it says `(with uncommitted changes)`, stop: the staging is not reproducible from a commit.
4. Review `git -C ../nimbalyst-wiki status --short` and the diff stat. Commit the generated mirror changes with `mcp__nimbalyst__developer_git_commit_proposal`, using absolute paths in the attached mirror repository and one repository per proposal. Include every generated change only after confirming the clone was clean in step 1. Describe the version and user-visible change in the commit message.
5. Ask, then `git -C ../nimbalyst-wiki push origin main`.
6. Verify the remote mirror commit equals the local commit, then verify both update-check channels (`packages/cli/src/mcp/updateCheck.ts`) and every install target:
   - `curl -s https://raw.githubusercontent.com/nimbalyst/nimbalyst/main/plugins/nimbalyst-wiki/.claude-plugin/plugin.json` reports the new version.
   - `gh api repos/nimbalyst/nimbalyst-wiki/contents/.claude-plugin/plugin.json -q .content | base64 -d` reports the new version. Check `.codex-plugin/plugin.json` and both files under `nimbalyst-wiki-team/` too: all four must report the release version.
   - Fetch the mirror's raw manifest without authentication to confirm public access. Check its published `.mcp.json`, `.codex-mcp.json` and `hooks/hooks.json` pin the installable CLI version. Verify the marketplace sources still resolve to the intended wiki and team add-on directories.

Do not change marketplace `source` entries as part of a ship. Verify the configured sources; source migrations are separate work.

## 5. Marketplace Worker

1. `pnpm --dir packages/marketplace exec tsc --noEmit -p .` and `pnpm exec vitest run packages/marketplace/__tests__`. Stop on failure.
2. Ask, then `pnpm --dir packages/marketplace run deploy:production`. It refuses uncommitted Worker sources and injects the version and commit.
3. `curl -s https://extensions.nimbalyst.com/health` must report the new version and a `commit` equal to `git rev-parse HEAD`. A null commit means the deploy predates `--var GIT_COMMIT`, or the var did not reach the Worker.
4. Commit `packages/marketplace/package.json` with `mcp__nimbalyst__developer_git_commit_proposal`, message `chore: deploy marketplace Worker vX.Y.Z`. Never tag it: tags in this repository reach the releases feed that the desktop app's update check reads.

## Report

One row per target: shipped, skipped (and why), pending (with the blocker and exact remaining step), or failed (at which step, and what state it left). Report the wiki plugin and team add-on explicitly, including Claude Code and Codex verification. Include the version, the verification you observed, and the commit or workflow run URL. List anything committed but not pushed in either repository. Do not call the overall ship complete while a selected plugin is pending, even if npm publication or the monorepo push succeeded.
