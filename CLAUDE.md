# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Critical Rules (read first)

### Keep Commit Messages and CHANGELOG Entries Short

**One-sentence commit subject. One-sentence CHANGELOG bullet.** Commit bodies may include short bullets for distinct key changes — one line each, no prose paragraphs, no root-cause explanations unless the diff truly can't explain itself. Match the existing voice in `[Unreleased]` and recent `git log --oneline`. If your draft is longer than the surrounding entries, cut it before submitting.

**One feature = one CHANGELOG bullet, no matter how many commits built it.** A multi-commit feature (e.g. a whole panel landed over a dozen PRs) gets a single user-facing line, not one bullet per commit. Do NOT append a new bullet for every follow-up commit to the same feature — edit the existing bullet instead. The `[Unreleased]` section must read like a short release summary, not a commit log.

**Never put internal scaffolding in the CHANGELOG.** No table/column names, IPC channel names, service/store class names, env-var plumbing, migration registration, poll intervals, or "internal scaffolding for the upcoming X" bullets. The changelog answers "what can I now do / what's fixed" for a user — if a line names a symbol or a file, it's wrong. Internal-only changes (typecheck, tests, refactors, doc/agent tweaks, lint, dep bumps with no behavior change) get NO entry.

**At release time, condense — don't ship the dev-time bullets verbatim.** `[Unreleased]` accumulates verbose per-commit bullets during development. Before tagging, collapse them: merge a feature's scattered bullets into one line, drop scaffolding, squash near-duplicates. If the release notes are longer than the equivalent section in a recent shipped version, cut harder.

### Write and Run Tests for Behavioral Changes

**Any change to runtime behavior ships with a unit test** — a new test, or an extension of an existing one. Pure refactors already covered by tests, formatting, docs, and config-only changes are exempt. Before pushing, run the gate locally: `npm run typecheck && npm run test:prepush`. The repo's pre-push hook runs this automatically; it installs on `npm install` (or `npm run hooks:install`). Never push to `main` with a red suite — CI on `main` is a backstop, not the gate. For high-risk areas (sync/collab, main-process init, IPC, restart-to-verify bugs) the test comes **first** and must fail before the fix — see [end-to-end-verification.md](./.claude/rules/end-to-end-verification.md).

### Use @floating-ui/react for All Popover/Tooltip/Menu Positioning

See [floating-ui.md](./.claude/rules/floating-ui.md). Never manually calculate `position: fixed` coordinates — always use `@floating-ui/react` with `FloatingPortal`.

### No Dynamic Imports in Electron Main Process

**NEVER convert static imports to dynamic `await import()`** unless absolutely necessary (confirmed circular reference) AND the user has approved it. Dynamic imports cause `__ELECTRON_LOG__` double-registration crashes and side-effect timing issues. All MCP servers and services in `index.ts` use static top-level imports. The only allowed exception is `bootstrap.ts` importing `index.ts` (see [MAIN_PROCESS_INIT.md](./packages/electron/MAIN_PROCESS_INIT.md)).

### CollabV3 Data Isolation — DOs for Customer Data, D1 for Entity Management Only

**Never store customer, org, or team-sensitive data in the D1 shared database.** Customer data (team metadata, member roles, key envelopes, tracker items, documents, sessions) must live in Durable Objects where each entity gets its own isolated SQLite instance. D1 is only for cross-entity management lookups (e.g., git remote hash → org ID mapping). See `packages/collabv3/CLAUDE.md` for the full policy.

### Never Use Environment Variables as Implicit API Key Sources

**NEVER read API keys from `process.env` as a fallback for provider authentication.** API keys must come only from values the user explicitly configured in Nimbalyst settings (the electron-store `apiKeys` object or project-level overrides).

Past incident: a user had `ANTHROPIC_API_KEY` in a `.env` file for unrelated work. Nimbalyst silently picked it up via `process.env`, auto-persisted it, and billed the user's personal Anthropic account $100+ instead of their Nimbalyst subscription.

- No env fallbacks in `getApiKeyForProvider` — only `globalApiKeys[provider]` or project-level overrides
- No auto-import into the settings store
- Provider availability checks must only consider explicitly-stored keys

If you are tempted to add `|| process.env.SOME_API_KEY` as a convenience fallback, **stop**.

### Database Access Rules

**Nimbalyst currently supports BOTH PGLite and better-sqlite3.** The migration is in progress; both backends are active in the codebase and the user's machine may be running either. Never write code that assumes one backend. Anywhere you touch the database — schema, queries, JSON handling, write paths — read [packages/electron/DATABASE.md](./packages/electron/DATABASE.md) for the divergent behaviors first.

The biggest gotcha: **JSONB sub-extraction (`data->'someKey'`) returns a parsed object on PGLite but a JSON string on SQLite.** Either select the whole `data` column and parse it, or defensively parse the sub-extracted value with the standard `typeof x === 'string' ? JSON.parse(x) : x` idiom. A real bug from this divergence corrupted tracker `labelsMap` rows on 2026-06-02 because `applyRemoteItem` trusted the sub-extraction was already an object.

**NEVER directly open or query the database files using Node.js or command-line tools.** PGLite at `~/Library/Application Support/@nimbalyst/electron/pglite-db` uses PID-based locking; better-sqlite3 takes its own exclusive lock. In both cases, opening from a second process risks corruption.

**ALWAYS use the MCP database query tool instead:**
- Use `mcp__nimbalyst-extension-dev__database_query` for all database queries
- NEVER use `node -e "const { PGlite } = require(...)"` or sqlite CLI

**For sync/collab bugs, local PGLite ≠ server collab state.** `tracker_body_cache`, `documents`, and other sync-related tables only reflect the local side. The authoritative state for shared trackers/documents lives in Cloudflare Workers (`packages/collabv3/` DurableObjects) and must be inspected separately via `wrangler tail` against the prod sync worker, or via wrangler-backed E2E tests (`tracker-content-collab.spec.ts` / `tracker-sync-collab.spec.ts` patterns, `RUN_COLLAB_TESTS=1`, `document-sync:open-test` IPC for Stytch bypass). Confirming "the body is in PGLite" is not the same as confirming "the body is on the server." See `feedback_local_state_vs_server_state.md`.

### Always Run Your Own Observation Commands — Don't Push Logs/Curl/Tail to the User

**Never ask the user to run `curl`, `wrangler tail`, `tail -f`, `gh` commands, or paste logs.** The agent has direct tool access to all of these.

- Logs: `mcp__nimbalyst-extension-dev__get_main_process_logs` and `get_renderer_debug_logs`
- Database: `mcp__nimbalyst-extension-dev__database_query`
- HTTP: `Bash` with `curl` — the agent runs it
- Cloudflare workers: `Bash` with `wrangler tail` — the agent runs it (long-running tails can use `run_in_background`)
- GitHub: `Bash` with `gh`
- Runtime DOM / renderer state: `mcp__nimbalyst-extension-dev__renderer_eval`

Past incident: session `702519e3` spent 23 turns debugging a Stytch JWKS rotation because the agent kept handing back commands for the user to run. The user finally said "run tail yourself!" and "you curl it!". If you catch yourself drafting "could you run X and paste the output?", stop and run X.

Detailed patterns: [DEBUGGING_LOGS.md](./docs/DEBUGGING_LOGS.md).

### End-to-End Verification Before Declaring Victory

For any bug whose verification requires a `/restart` or a user manually exercising a UI flow, the **first** deliverable is a failing test that the fix must make pass. Never announce "fixed" before observing the bug go from broken to working — either via a test that flips red→green, or via logs showing the failing step now succeeding. See [end-to-end-verification.md](./.claude/rules/end-to-end-verification.md).

Past incident: the 2026-05-20 tracker-body workstream announced "fixed" at least four times before the user finally said "you're killing me." Each announcement was based on "the code path looks right" or "tests pass," neither of which is the same as "the user can open the tracker and see the body."

## Codebase Overview

Nimbalyst is an extensible, AI-native workspace that supports multiple editor types through a unified extension system. While it originated as a Lexical-based markdown editor, the architecture is evolving toward a fully pluggable model where **all editors** — Lexical, Monaco, spreadsheets, diagrams, custom visual editors — are provided through extensions.

This monorepo contains the Electron desktop app, runtime services (including the Lexical editor), extension SDK, native iOS app, and mobile support via Capacitor.

## Extension Architecture

See [EXTENSION_ARCHITECTURE.md](./docs/EXTENSION_ARCHITECTURE.md) for the EditorHost contract, supported editor types (Monaco, Lexical, custom React), the manifest format, and extension development guidelines.

## Monorepo Structure

```
packages/
  electron/       # Desktop app (Electron)
  runtime/        # Cross-platform runtime services (AI, sync, Lexical editor)
  ios/            # Native iOS app (SwiftUI)
  core/           # Shared utilities
  collabv3/       # Collaboration server (Cloudflare Workers)
  extension-sdk/  # Extension development kit
  extensions/     # Built-in extensions
```

- **Install**: `npm install` at repository root
- **npm workspaces** (not pnpm); packages reference each other via workspace protocol
- **Preserve `peer: true` flags in package-lock.json** — Some `npm install` configurations strip these flags, breaking CI for optional native dependencies (e.g., esbuild platform binaries). Investigate before committing if you see them disappearing.

Package-specific docs: `/packages/electron/CLAUDE.md`, `/packages/runtime/CLAUDE.md`, `/packages/ios/CLAUDE.md`, `/packages/collabv3/CLAUDE.md`.

## Development Commands

**Electron app:**
- Start dev: `cd packages/electron && npm run dev` (user runs this — don't do it yourself)
- Build for Mac: `npm run build:mac:local` or `npm run build:mac:notarized`
- Main process log: `~/Library/Application Support/@nimbalyst/electron/logs/main.log`

**Testing:**
- Unit: `npm run test:unit` (vitest), or `npm run test:unit:ui`
- E2E: see [E2E_TESTING.md](./docs/E2E_TESTING.md)

**Marketing screenshots & videos:** See [MARKETING_SCREENSHOTS.md](./docs/MARKETING_SCREENSHOTS.md). Quick: `cd packages/electron && npm run marketing:screenshots` (requires dev server on port 5273).

**Multiple dev instances** (for collab/sync testing): `cd packages/electron && npm run dev:user2` uses an isolated `NIMBALYST_USER_DATA_DIR`, `VITE_PORT=5274`, and `--outDir=out2` to prevent file-watcher cross-talk. Worktrees auto-derive a per-worktree userData dir via `crystal-run.sh`.

**Other packages:** iOS — `npm run ios:test:swift`, `npm run ios:build:transcript`. Collab server — `npm run collabv2:dev`, `npm run collabv2:deploy`.

## Releases

See [RELEASING.md](./RELEASING.md). Use `/release-alpha [patch|minor|major]`. All release notes go in the `[Unreleased]` section of `CHANGELOG.md`; the script creates versioned entries and annotated git tags.

## Cross-Cutting Patterns

- **Error handling** — fail fast, validate at boundaries, workspace-scoped IPC takes `workspacePath` explicitly. See [ERROR_HANDLING.md](./docs/ERROR_HANDLING.md).
- **Naming conventions** — `camelCase` for wire protocol/JSON; `snake_case` only for SQL columns. See [NAMING_CONVENTIONS.md](./docs/NAMING_CONVENTIONS.md).
- **React DOM markers** — Tailwind utilities don't replace semantic class names. Every meaningful component needs a stable kebab-case class on its root. See [REACT_DOM_MARKERS.md](./docs/REACT_DOM_MARKERS.md).

## Data Persistence

The app uses **PGLite** (PostgreSQL in WebAssembly) for all data storage.

- **Never use `localStorage` in the renderer.** Use app-settings store (global), workspace-settings store (per-project), or PGLite (complex data like AI sessions/document history).
- **All database timestamps must use `TIMESTAMPTZ`.** Never create `TIMESTAMP` (without timezone) columns; migrate legacy tables.

See [DATABASE.md](./packages/electron/DATABASE.md) for tables, locations, shutdown rules, and timestamp handling.

## Transcript Storage

Two-tier architecture — `ai_agent_messages` (raw append-only log, sole source of truth) → `ai_transcript_events` (canonical, provider-agnostic, derived). The `TranscriptTransformer` is the single writer of canonical events; providers only write raw. See [TRANSCRIPT_ARCHITECTURE.md](./docs/TRANSCRIPT_ARCHITECTURE.md).

## Documentation Reference

**Read the relevant doc in its entirety before making changes in that area.** These contain authoritative patterns, anti-patterns, and architectural decisions.

| File | Read when… |
| --- | --- |
| [EXTENSION_ARCHITECTURE.md](./docs/EXTENSION_ARCHITECTURE.md) | Working on extensions, creating editors, modifying editor↔host communication, adding new editor types. |
| [IPC_LISTENERS.md](./docs/IPC_LISTENERS.md) | Adding IPC events, debugging stale closures / race conditions in event handling, or seeing `MaxListenersExceededWarning`. |
| [IPC_GUIDE.md](./docs/IPC_GUIDE.md) | Writing main-process IPC handlers, adding `electronAPI` methods, or debugging main↔renderer IPC. |
| [EDITOR_STATE.md](./docs/EDITOR_STATE.md) | Working on editor components or TabEditor infrastructure; debugging editor state. |
| [JOTAI.md](./docs/JOTAI.md) | Working with Jotai atoms, debugging UI/state divergence, or adding new atoms. |
| [STATE_PERSISTENCE.md](./docs/STATE_PERSISTENCE.md) | Adding fields to any persisted state, or debugging "Cannot read properties of undefined" on app load. |
| [UI_PATTERNS.md](./docs/UI_PATTERNS.md) | Writing UI components, styling with CSS/Tailwind, or adding responsive behavior. |
| [ERROR_HANDLING.md](./docs/ERROR_HANDLING.md) | Writing IPC handlers or service methods that take required parameters or handle workspace state. |
| [NAMING_CONVENTIONS.md](./docs/NAMING_CONVENTIONS.md) | Designing wire protocols, sync code, or SQL schemas. |
| [AI_PROVIDER_TYPES.md](./docs/AI_PROVIDER_TYPES.md) | Working on AI integration, adding providers, or modifying model selection. |
| [TRANSCRIPT_ARCHITECTURE.md](./docs/TRANSCRIPT_ARCHITECTURE.md) | Working on transcript rendering, parsers, the canonical event pipeline, or mobile transcript sync. |
| [CONTEXT_WINDOW_USAGE_TRACKING.md](./docs/CONTEXT_WINDOW_USAGE_TRACKING.md) | Working on context-usage display, token tracking, or `ClaudeCodeProvider` streaming. |
| [INTERNAL_MCP_SERVERS.md](./docs/INTERNAL_MCP_SERVERS.md) | Adding MCP server functionality or new tools for AI agents. |
| [CUSTOM_TOOL_WIDGETS.md](./docs/CUSTOM_TOOL_WIDGETS.md) | Creating visual displays for MCP tool results or customizing tool rendering. |
| [INTERACTIVE_PROMPTS.md](./docs/INTERACTIVE_PROMPTS.md) | Working on durable prompts (AskUserQuestion, ExitPlanMode, GitCommitProposal, ToolPermission). |
| [WORKTREES.md](./docs/WORKTREES.md) | Working on worktree features, session isolation, or session↔worktree linkage. |
| [SESSION_HIERARCHY.md](./docs/SESSION_HIERARCHY.md) | Creating/parenting sessions or debugging session grouping in the left pane. |
| [HELP_WALKTHROUGHS.md](./docs/HELP_WALKTHROUGHS.md) | Adding help tooltips, creating walkthroughs, or modifying help content. |
| [REACT_DOM_MARKERS.md](./docs/REACT_DOM_MARKERS.md) | Working on React UI, adding components, or improving testability/devtools navigation. |
| [WALKTHROUGHS.md](./docs/WALKTHROUGHS.md) | Creating multi-step walkthroughs or debugging walkthrough flow. |
| [E2E_TESTING.md](./docs/E2E_TESTING.md) | Writing/debugging E2E tests, or running them as an AI agent (especially in worktrees). |
| [DIALOGS.md](./docs/DIALOGS.md) | Adding or modifying modal dialogs. |
| [AGENT_PERMISSIONS.md](./docs/AGENT_PERMISSIONS.md) | Working on agent permissions, approval flows, or runtime permission checks. |
| [ANALYTICS_GUIDE.md](./docs/ANALYTICS_GUIDE.md) | Adding/modifying PostHog events, or using PostHog MCP tools. |
| [POSTHOG_EVENTS.md](./docs/POSTHOG_EVENTS.md) | Adding, modifying, or removing any PostHog analytics event — keep this in sync. |
| [POSTHOG_MCP_INTEGRATION.md](./docs/POSTHOG_MCP_INTEGRATION.md) | Using PostHog MCP tools or extending PostHog functionality. |
| [THEMING.md](./packages/electron/THEMING.md) | Working on themes or color schemes. |
| [RELEASING.md](./RELEASING.md) | Preparing a release or debugging release scripts. |
| [MARKETING_SCREENSHOTS.md](./docs/MARKETING_SCREENSHOTS.md) | Adding marketing screenshots/videos or modifying capture choreography. |
| [FILE_WATCHING_AND_CHANGE_TRACKING.md](./docs/FILE_WATCHING_AND_CHANGE_TRACKING.md) | Working on file watchers, AI change detection, diff display, or the FilesEditedSidebar. |
| [WEEKLY_DASHBOARD.md](./docs/WEEKLY_DASHBOARD.md) | Adding/modifying insights on the Weeklys PostHog dashboard. |
| [VOICE_MODE.md](./docs/VOICE_MODE.md) | Working on voice mode, voice-agent prompts, audio pipeline, or session lifecycle. |
| [TRACKER_WORKFLOWS.md](./docs/TRACKER_WORKFLOWS.md) | Creating decision or bug tracker items as part of a fix or design decision. |
| [ARCHITECTURE_DIAGRAMS.md](./docs/ARCHITECTURE_DIAGRAMS.md) | Making any architectural decision — create an Excalidraw diagram. |
| [DEBUGGING_LOGS.md](./docs/DEBUGGING_LOGS.md) | Investigating bugs — use the log access tools, don't ask the user to paste logs. |
| [MAIN_PROCESS_INIT.md](./packages/electron/MAIN_PROCESS_INIT.md) | Working on Electron main-process bootstrap, singleton init, or IPC handler registration. |
| [DATABASE.md](./packages/electron/DATABASE.md) | Working with PGLite tables, shutdown, or timestamp handling. |

## AI Features (quick reference)

- **AI Chat Panel**: multi-provider (Claude, OpenAI, LM Studio, Claude Code), document-aware; Cmd+Shift+A
- **Session Manager**: global view (Cmd+Alt+S); search, export, delete
- **Model Configuration**: dynamic from provider APIs; no hardcoded models
- **Git Worktrees**: isolated AI coding sessions via "New Worktree" button

## Tracker Workflows

When choosing between alternatives (libraries, patterns, deciding NOT to do something), log a **decision** tracker item. When fixing a bug, ensure a **bug** tracker item exists before writing fix code. See [TRACKER_WORKFLOWS.md](./docs/TRACKER_WORKFLOWS.md) for the exact `tracker_create` calls and lifecycle.

## Architecture Diagrams for Decisions

Whenever an architectural change is proposed, create an Excalidraw diagram in `nimbalyst-local/architecture/` and share the diagram file/link in the conversation. Use `capture_editor_screenshot` only when visual verification is needed or the user explicitly asks for an inline image. See [ARCHITECTURE_DIAGRAMS.md](./docs/ARCHITECTURE_DIAGRAMS.md).

## Verifying Development Mode

Before making code changes, use `mcp__nimbalyst-extension-dev__get_environment_info` to verify Nimbalyst is running in dev mode. If the user is running a packaged build, code changes won't take effect — tell them to start the dev server.

## Debugging with Log Access Tools

See the Critical Rules block above ("Always Run Your Own Observation Commands"). Detailed patterns: [DEBUGGING_LOGS.md](./docs/DEBUGGING_LOGS.md).

## General Development Guidelines

- **Never use emojis** — not in commits, code, or documentation, unless explicitly requested
- **Never use overly enthusiastic phrases** ("Perfect!", "Terrific!", etc.)
- **Never commit changes unless explicitly asked**
- **Never commit files under `nimbalyst-local/`** — gitignored, local-only working files
- **Never provide time or effort estimates**
- **Don't disable tests without asking first**
- **Don't run `npm run dev` yourself** — user does that
- **Never release without being explicitly instructed**
- **Don't `git reset` or `git add -A` without asking**
- **Don't add `Co-Authored-By` lines to commit messages**
- **Never restart Nimbalyst without explicit permission** — always ask before `restart_nimbalyst`
- **Never mark work as done/completed without user approval** — set tracker items to a review state (e.g., `in-review`), session phase to `validating`, never `done` / `completed` / `complete`. Only the user can promote to those states.

**Keyboard Shortcuts**: when adding or modifying shortcuts, update `KeyboardShortcutsDialog.tsx`.

## Support

User support docs live in `support/`. Notable: `force-restore-database-backup.md` for manual database restore.
if i ask you to propose a commit, first update the `CHANGELOG.md` (at the repo root) and include it in the commit proposal
if a commit is intended to fix a github issue, include the issue number and a closing reference in the commit message when appropriate (fixes #123 or closes #123)
