---
name: update-libs
description: Update Anthropic Agent SDK, MCP library, and Codex SDK to latest versions
argument-hint: "[claude code | mcp | codex | all]  (default: all)"
---
Update the Anthropic Agent SDK, MCP library, and OpenAI Codex SDK to their latest versions.

**This command is always a two-phase execution.** Phase 1 evaluates the available updates and reports impact. Then STOP and wait for explicit user direction before starting Phase 2 (the actual upgrade). Do not perform any package.json edits, `pnpm install`, or commits in Phase 1.

## Scope from arguments (`$ARGUMENTS`)

The user may name a single library. Resolve `$ARGUMENTS` to the set of packages to work on. **Only evaluate and upgrade the packages in scope** — skip the others entirely (don't fetch their changelogs, don't include them in the report, don't touch their package.json).

| Argument (case-insensitive, fuzzy) | Package(s) in scope |
| --- | --- |
| empty, `all`, `everything` | all three |
| `claude`, `claude code`, `agent`, `agent sdk`, `anthropic`, `sdk` | `@anthropic-ai/claude-agent-sdk` only |
| `mcp`, `modelcontextprotocol` | `@modelcontextprotocol/sdk` only |
| `codex`, `openai`, `codex sdk` | `@openai/codex-sdk` only |

If the argument is ambiguous or names something not in the table, ask the user which library they mean before doing anything (use the AskUserQuestion tool). When a single library is in scope, phrase the whole report and the Phase 2 prompt around just that one — don't mention the others.

## Libraries

1. **@anthropic-ai/claude-agent-sdk** — root `package.json` (also pinned in `overrides`)
2. **@modelcontextprotocol/sdk** — `packages/electron/package.json`
3. **@openai/codex-sdk** — `packages/runtime/package.json` (and `packages/electron/package.json` if present)

---

## Phase 1: Evaluation (always run first)

Goal: tell the user what would change and what to consider, without modifying anything.

1. **Check current versions** by reading the relevant package.json files (root, `packages/electron`, `packages/runtime`). For claude-agent-sdk also note the `overrides` pin in the root `package.json`.
2. **Fetch latest versions** from npm for each in-scope package:
  - `pnpm view @anthropic-ai/claude-agent-sdk version`
  - `pnpm view @modelcontextprotocol/sdk version`
  - `pnpm view @openai/codex-sdk version`
  - Use `pnpm view <pkg> versions --json` to enumerate the intermediate versions between current and latest.
3. **Get changelogs** for the full gap between current and latest:
  - **claude-agent-sdk**: fetch the SDK changelog at https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md. If entries say "brought up to CLI version X.Y.Z", also fetch the Claude Code CLI changelog at https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md for those CLI versions.
  - **MCP SDK**: fetch https://github.com/modelcontextprotocol/typescript-sdk/releases.
  - **Codex SDK**: use `gh release view rust-v<version> --repo openai/codex --json body` for each version in the gap (npm `@openai/codex-sdk` releases are tagged `rust-v<version>` in openai/codex). The npm page returns 403 to WebFetch, so don't waste a call there.

4. **Read the changelog for us, not just at us.** Go through every entry in the gap and sort each one into one of these buckets. This is the core of the report — the version bump is mechanical; the value is knowing what the changelog means for Nimbalyst. Grep our actual usage before deciding (`from '@anthropic-ai/claude-agent-sdk'`, `from '@openai/codex-sdk'`, MCP SDK imports; and the option-builders `sdkOptionsBuilder.ts`, `CodexSDKProtocol.ts:buildThreadOptions`).

  - **Bug fixes that help us** — a fix for something we've hit or could hit. Cross-reference our known-pain areas: prompt-cache prefix stability, background-task completion semantics, resume/flush behavior, streaming/token accounting, MCP tool-call handling, session lifecycle. If a fix lands on a bug we have an open tracker item or a workaround for, call that out explicitly — it may let us delete a workaround.
  - **Breaking / action-required changes** — anything that changes the API surface we consume (`query()`, `client.startThread()`, `client.resumeThread()`, options shape), removes/renames an option we pass, changes a default, or changes runtime behavior we depend on. For each, state exactly what we'd have to change and where. Deprecations: confirm via Grep whether we use the deprecated symbol; if we don't, say so.
  - **New features worth adopting** — new options, tools, or capabilities we don't use yet but probably should. Note whether we currently pass/handle it and roughly what wiring it up would touch. Flag anything that would be a genuinely new Nimbalyst capability (worth its own follow-up session), separate from the mechanical upgrade.
  - **Irrelevant / internal-only** — internal refactors and changes that don't touch the API surface we consume. Summarize these in one line; don't dwell.

5. **Assign a risk level** (Low / Medium / High) per in-scope library based on the above — driven by the breaking/action-required bucket, not by how many versions we're jumping.

6. **Surface upgrade-time considerations** in a "Things to consider" section:
  - Native binary integrity: both SDKs ship platform binaries via `extraResources`/`optionalDependencies`. Past incidents (`feedback_extraresources_vs_files_globs.md`, `feedback_windows_arm64_install_scripts.md`) show the package manager silently skips these on stale integrity hashes.
  - The `overrides` pin for `@anthropic-ai/claude-agent-sdk` in root `pnpm-workspace.yaml` must be bumped in lockstep or the upgrade is silently neutered.
  - `minimumReleaseAge` (72h) in `pnpm-workspace.yaml`: a version published less than 3 days ago will not resolve. If the latest SDK release is that fresh, target the newest older version, or add a scoped `minimumReleaseAgeExclude` entry with a reason if the user approves.
  - `allowBuilds` in `pnpm-workspace.yaml`: if an SDK bump introduces a package with an install script, `pnpm install` fails until it is listed as `true` or `false`.
  - Per project memory: never bump `TranscriptTransformer.CURRENT_VERSION` as part of an SDK upgrade.
  - Per project memory: don't revert `@anthropic-ai/claude-agent-sdk` past 0.2.113.
  - Hardcoded model defaults that may be affected by model-catalog refreshes (e.g., `model: 'gpt-5'` in `CodexSDKProtocol.ts`).
  - Smoke-test scope to recommend before shipping.

7. **STOP.** End your turn with an explicit prompt (AskUserQuestion) asking whether to proceed with Phase 2. Do not edit files, run `pnpm install`, or commit. Wait for the user's response.

If an in-scope package is already at the latest version, say so and drop it from the Phase 2 plan.

## Output Format for Phase 1

Include a section only for in-scope libraries.

### <package name>
- **Current**: [version] (for claude-agent-sdk, also root `overrides`: [version])
- **Latest**: [version]
- **Versions in gap**: [list]
- **Fixes that help us**: [bullets — each tied to a concrete Nimbalyst code path or tracker item, or "none relevant"]
- **Breaking / action-required**: [bullets — what changes and the file we'd touch, or "none"]
- **Features worth adopting**: [bullets — what it is + what wiring it up would touch, or "none"]
- **Other changes**: [one line]
- **Risk**: Low / Medium / High

### Things to consider
- [Native binary integrity check items]
- [Override pin reminder — if claude-agent-sdk in scope]
- [Hardcoded defaults that may need verification]
- [Smoke-test scope]
- [Recommendation: upgrade now, or defer]

### Awaiting direction
Ask (AskUserQuestion) whether to proceed with Phase 2 for the in-scope library/libraries.

---

## Phase 2: Implementation (only after user confirms)

Do not start until the user has explicitly approved. Only touch the packages they confirmed.

1. **Update versions** in the respective package.json files:
  - `@anthropic-ai/claude-agent-sdk`: update the workspace dependency entries AND the `overrides` pin in root `pnpm-workspace.yaml` (exact version, no caret, for the override).
  - `@modelcontextprotocol/sdk`: in `packages/electron/package.json` (caret prefix).
  - `@openai/codex-sdk`: in `packages/runtime/package.json` and `packages/electron/package.json` if present (caret prefix).
2. **Run `pnpm install`** at the repository root to update `pnpm-lock.yaml`.
3. **Verify** with `pnpm why <package-name>` (or `pnpm list -r <package-name>`) for each updated package. If it still resolves the old version despite the package.json change:
  - Check whether `minimumReleaseAge` blocked the new version, and whether the `overrides` pin in `pnpm-workspace.yaml` was bumped.
  - Use `pnpm view <package>@<version> --json` to confirm the version exists and read its `dependencies`.
  - Re-run `pnpm install` and verify again. Do not hand-edit `pnpm-lock.yaml`.
4. **Verify Codex platform binaries** (if codex in scope) — `@openai/codex-sdk` depends on `@openai/codex`, which has optional platform-specific binary packages (e.g., `@openai/codex-darwin-arm64`). Check `ls node_modules/@openai/codex-darwin-arm64/vendor/`. If missing: `pnpm --filter @nimbalyst/electron --filter @nimbalyst/runtime add @openai/codex-sdk@<version>`, then verify again.
5. **Verify claude-agent-sdk platform binaries** (if claude in scope) — check `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/` (or host platform) exists.
6. **Verify the lockfile diff** — `git diff --stat pnpm-lock.yaml pnpm-workspace.yaml` should show only the updated packages and their trees; optional native platform packages must still be present.
7. **Apply any action-required code changes** identified in Phase 1 (option renames, default changes). Behavioral changes ship with a test per the repo rule.
8. **Commit the changes** — summarize which packages were updated and their version changes (e.g., "deps: update claude-agent-sdk 0.2.117 -> 0.2.121"). Stage only the touched package.json files, `pnpm-lock.yaml`, and `pnpm-workspace.yaml` if the override changed. Do not skip hooks. Do not add Co-Authored-By lines.
