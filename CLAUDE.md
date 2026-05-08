# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## CRITICAL: Use @floating-ui/react for All Popover/Tooltip/Menu Positioning

See [floating-ui.md](./.claude/rules/floating-ui.md) for full guidance. Never manually calculate `position: fixed` coordinates — always use `@floating-ui/react` with `FloatingPortal`.

## CRITICAL: No Dynamic Imports in Electron Main Process

**NEVER convert static imports to dynamic \****`await import()`**\*\* unless absolutely necessary** (confirmed circular reference) AND the user has approved it.

Dynamic imports in the Electron main process cause `__ELECTRON_LOG__` double-registration crashes and other side-effect timing issues. All MCP servers and services in `index.ts` use **static top-level imports** - follow this pattern.

- `httpServer`, `SessionNamingService`, `sessionContextServer` - all use static top-level imports
- Dynamic `await import('./mcp/sessionContextServer')` caused server startup failure - fixed by switching to static import

## CRITICAL: CollabV3 Data Isolation -- DOs for Customer Data, D1 for Entity Management Only

**Never store customer, org, or team-sensitive data in the D1 shared database.** D1 is a multi-tenant SQL database where every Worker request can query any row. Customer data (team metadata, member roles, key envelopes, tracker items, documents, sessions) must live in Durable Objects where each entity gets its own isolated SQLite instance. D1 is only for cross-entity management lookups (e.g., git remote hash -> org ID mapping). See `packages/collabv3/CLAUDE.md` for the full policy.

## CRITICAL: Never Use Environment Variables as Implicit API Key Sources

**NEVER read API keys from `process.env` as a fallback for provider authentication.** API keys must only come from values the user explicitly configured in Nimbalyst settings (the electron-store `apiKeys` object or project-level overrides).

A user had `ANTHROPIC_API_KEY` in a `.env` file for unrelated development. Nimbalyst silently picked it up via `process.env`, auto-persisted it into the settings store, and used it for API calls — billing the user's personal Anthropic account $100+ instead of their Nimbalyst subscription.

- **No env fallbacks**: `getApiKeyForProvider` must return only from `globalApiKeys[provider]` or project-level overrides — never `process.env.*_API_KEY`
- **No auto-import**: Never copy env vars into the settings store automatically (the old `initializeApiKeys` pattern)
- **No implicit enablement**: Provider availability checks must only consider explicitly-stored keys, not env vars

If you are tempted to add `|| process.env.SOME_API_KEY` as a convenience fallback, **stop**. The user did not consent to using that key with Nimbalyst.

## CRITICAL: Database Access Rules

**NEVER directly open or query the PGLite database files using Node.js or command-line tools.**

The database at `~/Library/Application Support/@nimbalyst/electron/pglite-db` uses PID-based locking and **can only be safely accessed by one process at a time**. Opening it from a second process (like a Node.js script) will:
- Corrupt the database
- Require database recovery
- Potentially lose data

**ALWAYS use the MCP database query tool instead:**
- ✅ Use `mcp__nimbalyst-extension-dev__database_query` for all database queries
- ❌ NEVER use `node -e "const { PGlite } = require(...)"` or similar approaches
- ❌ NEVER use sqlite CLI or any direct file access

The MCP tool safely queries the database through the running Nimbalyst process, which already has the exclusive lock.

## Codebase Overview

Nimbalyst is an extensible, AI-native workspace that supports multiple editor types through a unified extension system. While it originated as a Lexical-based markdown editor, the architecture is evolving toward a fully pluggable model where **all editors** - including the core Lexical editor, Monaco code editor, spreadsheets, diagrams, and custom visual editors - are provided through extensions.

This is a monorepo containing multiple packages including the Electron desktop app, runtime services (including the Lexical-based editor), extension SDK, native iOS app, and mobile support via Capacitor (for Android).

## Extension Architecture

Nimbalyst's extension system allows third-party and built-in extensions to provide custom editors, file handlers, and UI components. Extensions are self-contained packages that declare their capabilities via a manifest and communicate with the host application through a well-defined contract.

**Key concepts:**
- **EditorHost**: The interface editors use to communicate with Nimbalyst (loading/saving content, marking dirty state, handling external file changes)
- **File type registration**: Extensions declare which file extensions they handle (e.g., `.excalidraw`, `.mockup.html`, `.datamodel`)
- **Editor types**: Monaco (code), Lexical (rich text), and custom React components for specialized editing experiences

See [EXTENSION_ARCHITECTURE.md](./docs/EXTENSION_ARCHITECTURE.md) for the EditorHost contract, supported editor types, and extension development guidelines.

## Monorepo Structure

### Workspaces
```
packages/
  electron/       # Desktop app (Electron)
  runtime/        # Cross-platform runtime services (AI, sync, Lexical editor)
  ios/            # Native iOS app (SwiftUI)
  core/           # Shared utilities
  collabv3/       # Collaboration server
  extension-sdk/  # Extension development kit
  extensions/     # Built-in extensions
```

### Package Management
- **Install dependencies**: `npm install` at repository root
- **Uses npm workspaces** (not pnpm)
- Packages can reference each other via workspace protocol
- **IMPORTANT: Preserve \****`peer: true`**\*\* flags in package-lock.json** - The lock file contains `peer: true` flags for optional native dependencies (like esbuild platform binaries). Running `npm install` with certain npm versions or configurations can strip these flags, breaking CI. If you see `peer: true` flags disappearing from package-lock.json diffs, investigate before committing.

### Package-Specific Documentation
For detailed information about specific packages, see their CLAUDE.md files:
- `/packages/electron/CLAUDE.md` - Electron desktop app specifics
- `/packages/runtime/CLAUDE.md` - AI providers, runtime services, and Lexical editor
- `/packages/ios/CLAUDE.md` - Native iOS app (SwiftUI)
- `/packages/collabv3/CLAUDE.md` - Sync server (Cloudflare Workers)

## Development Commands

### Electron App
- **Start dev server**: `cd packages/electron && npm run dev`
- **Build for Mac**: `cd packages/electron && npm run build:mac:local`
- **Build for Mac (notarized)**: `cd packages/electron && npm run build:mac:notarized`
- **Main process log file**: `~/Library/Application Support/@nimbalyst/electron/logs/main.log`

### Testing
- **Unit tests**: `npm run test:unit` - Uses vitest
- **Test UI**: `npm run test:unit:ui`
- **E2E tests**: See [E2E_TESTING.md](./docs/E2E_TESTING.md) for comprehensive documentation

### Marketing Screenshots & Videos
- **Capture all**: `cd packages/electron && npm run marketing:screenshots`
- **Capture by category**: `cd packages/electron && npm run marketing:screenshots:grep -- "hero-"` (also: `editor-`, `ai-`, `settings-`, `feature-`, `video-`)
- **Requires dev server running** on port 5273 (`cd packages/electron && npm run dev`)
- **Output**: `packages/electron/marketing/screenshots/{dark,light}/` (1440x900 PNG) and `packages/electron/marketing/videos/{dark,light}/` (WebM)
- **Post-process videos**: `bash packages/electron/marketing/process-videos.sh` (converts WebM to MP4/GIF via ffmpeg)
- See [MARKETING_SCREENSHOTS.md](./docs/MARKETING_SCREENSHOTS.md) for architecture, output inventory, and how to add new screenshots

### Running Multiple Dev Instances

For testing collaborative features (teams, sync, etc.), you can run multiple isolated Electron instances simultaneously. Each instance needs its own **userData directory** (settings, database, credentials) and **Vite port** to avoid conflicts.

**Second instance on same checkout:**
```bash
cd packages/electron && npm run dev:user2
```
This uses `NIMBALYST_USER_DATA_DIR` for an isolated userData dir, `VITE_PORT=5274`, and `--outDir=out2` to prevent electron-vite file watcher cross-talk between instances.

**Worktree instance** (via `crystal-run.sh`):
Worktrees already have separate source/build trees, so no `--outDir` is needed. When `WORKTREE_MODE=true`, `crystal-run.sh` automatically derives a per-worktree userData dir (`electron-wt-<name>`).

**Why separate outDir matters:** Without it, two `electron-vite dev` processes sharing the same `out/main/index.js` cause the file watcher on one instance to restart the other on rebuild. Module-level singletons (like the `electron-store` instances) from one process bleed into the other, cross-pollinating settings, theme, and workspace state.

**Path resolution:** `getPreloadPath()` and `getPackageRoot()` in `src/main/utils/appPaths.ts` correctly resolve preload scripts and worker bundles regardless of which outDir is in use. All window files use these helpers -- do not inline path resolution logic.

### Other Packages
- **iOS (native)**: `npm run ios:test:swift`, `npm run ios:build:transcript`
- **Collaboration server**: `npm run collabv2:dev`, `npm run collabv2:deploy`

## Releases

For detailed release instructions, see [RELEASING.md](./RELEASING.md).

**Quick reference:**
- Use the `/release-alpha [patch|minor|major]` command
- All release notes go in the `[Unreleased]` section of `CHANGELOG.md`
- The release script automatically creates versioned entries and annotated git tags

## Cross-Cutting Patterns

### Error Handling Philosophy

**CRITICAL: Fail fast, fail loud. Never hide failures.**

1. **Never log-and-continue for required parameters** - throw immediately instead
2. **Never fall back to default values that mask routing issues** - fail if routing is broken
3. **Always use stable identifiers for routing** - workspace paths (stable) not window IDs (transient)
4. **Validate at boundaries** - All IPC handlers and service methods MUST validate required parameters
5. **Workspace-scoped IPC must take `workspacePath` as a required parameter** - the renderer always knows its window's workspace; pass it explicitly. Main-process handlers and services MUST NOT fall back to module-level "current workspace" state — that state is shared across windows and last-write-wins between them, producing silent cross-window pollution (e.g. `[SessionManager] Rejecting session ... belongs to /path/A, not /path/B`). Carve-out: genuinely app-global channels (theme, app settings, app version, analytics consent, update checks) don't need a workspace. If you can't decide whether a channel is workspace-scoped, it is — default to "scoped + required parameter." See [IPC_GUIDE.md](./docs/IPC_GUIDE.md) for the full rule and worked example.

**Rule of thumb:** If you're adding code to "handle" missing required data, you're probably hiding a bug. Throw instead.

### Workspace State Persistence

**CRITICAL: Use deep merge for all nested workspace state updates.**

The `workspace:update-state` IPC handler uses a **deep merge** function (not shallow `Object.assign`). This allows multiple modules to safely update different fields in nested structures without overwriting each other. No manual read-modify-write needed.

### Naming Conventions

**Use camelCase everywhere except SQL column names and file system paths.**

- **TypeScript/Swift interfaces, fields, variables**: `camelCase` always
- **Wire protocol (WebSocket/HTTP JSON)**: `camelCase` - no snake_case in JSON payloads
- **Message type discriminators**: `camelCase` (e.g., `'syncRequest'`, `'appendMessage'`, NOT `'sync_request'`, `'append_message'`)
- **SQL column names**: `snake_case` (standard SQL convention, stays internal to the database layer)
- **Row-to-wire mappers**: When reading from SQL, map `snake_case` columns to `camelCase` fields at the boundary (e.g., `{ sessionId: row.session_id }`)

This applies to all packages: collabv3 server, runtime sync client, Electron SyncManager, and iOS SyncProtocol. Never introduce snake_case into wire-format JSON even if it "looks more API-like" - this is a private protocol consumed only by our own TypeScript and Swift clients.

### React DOM Markers

**CRITICAL: Tailwind utilities do not replace semantic DOM markers.**

When building or modifying React UI:

1. **Use Tailwind for styling, semantic class names for structure.**
   - Tailwind utility classes control visual presentation.
   - Stable semantic class names make the DOM legible in browser developer tools and survive styling refactors.

2. **Every meaningful exported component should mark its root DOM element.**
   - Add one stable semantic class name on the topmost meaningful element.
   - Use kebab-case derived from the component or feature name: `session-card`, `tracker-sidebar`, `settings-panel`.
   - Do this even when all styling is expressed with Tailwind utilities.

3. **Use `data-testid` for test targeting, not as a substitute for semantic DOM markers.**
   - Add `data-testid` to important interactive elements, dialogs, and recurring test targets.
   - If an element matters for both debugging and testing, give it both a semantic class and a `data-testid`.

4. **Prefer explicit debug metadata in development-facing UI when practical.**
   - `data-component` and `data-source` are appropriate for important component roots when they support DOM-to-source navigation or debugging workflows.
   - These attributes complement semantic classes; they do not replace them.

5. **Do not leave important UI rooted in utility-only class strings.**
   - A root like `className="flex items-center gap-2 px-3 ..."` is not sufficient for major UI structure.
   - Add a stable semantic token such as `className="session-toolbar flex items-center gap-2 px-3 ..."`.

## Documentation Reference

**You MUST read the relevant documentation files when working on or investigating issues in the corresponding areas.**

Read the file **in its entirety** before making changes. These documents contain critical patterns, anti-patterns, and architectural decisions that must be followed. Treat them as authoritative instructions equivalent to anything in this CLAUDE.md file.

| File | Description | Read when... |
| --- | --- | --- |
| [EXTENSION_ARCHITECTURE.md](./docs/EXTENSION_ARCHITECTURE.md) | Documents the EditorHost contract that all editors must implement, supported editor types (Monaco, Lexical, custom), and how extensions register capabilities. Includes the extension manifest format and lifecycle hooks. | Working on extensions, creating custom editors, modifying how editors communicate with the host, or adding new editor types to the system. |
| [IPC_LISTENERS.md](./docs/IPC_LISTENERS.md) | Explains the centralized IPC listener architecture where components NEVER subscribe to IPC events directly. Central listeners in `store/listeners/` update Jotai atoms, and components read from atoms. Includes debouncing patterns. | Adding new IPC events, debugging why events aren't reaching components, fixing race conditions or stale closures in event handling, or seeing MaxListenersExceededWarning errors. |
| [IPC_GUIDE.md](./docs/IPC_GUIDE.md) | Covers IPC patterns for main/renderer communication including `safeHandle`, `safeOn`, error handling, and how to structure IPC channels. Documents the preload API and type safety patterns. | Writing new IPC handlers in the main process, creating new electronAPI methods, or debugging IPC communication issues between main and renderer. |
| [EDITOR_STATE.md](./docs/EDITOR_STATE.md) | Explains why "lift state up" is an anti-pattern for editors in this codebase. Editors own their content state via EditorHost, not parent components. Covers Jotai atom families for tab metadata (dirty, processing). | Working on editor components, TabEditor infrastructure, understanding why editor state is structured this way, or fixing state management issues in editors. |
| [JOTAI.md](./docs/JOTAI.md) | Covers derived atoms for session state, atom families for per-entity state, and persistence patterns. Documents critical anti-patterns like dynamic imports in atoms and async derived atoms that cause state divergence. | Working with Jotai atoms, debugging state divergence between UI and actual state, adding new atoms, or understanding why state updates aren't reflecting in components. |
| [STATE_PERSISTENCE.md](./docs/STATE_PERSISTENCE.md) | Documents migration safety patterns for persisted state that may be missing fields added after it was saved. Covers `createDefault*()` functions, `??` operator merging, and the checklist for adding new persisted fields. | Adding new fields to any persisted state interface (workspace state, app settings, workstream state), or debugging "Cannot read properties of undefined" errors on app load. |
| [UI_PATTERNS.md](./docs/UI_PATTERNS.md) | Covers the canonical `--nim-*` CSS variable names and their Tailwind equivalents, container queries (not media queries), Tailwind conditional class patterns using ternaries, and text selection opt-in rules. | Writing UI components, styling with CSS or Tailwind, fixing styling inconsistencies, or adding responsive behavior to panels and components. |
| [AI_PROVIDER_TYPES.md](./docs/AI_PROVIDER_TYPES.md) | Distinguishes Agent providers (Claude Code with MCP support, file system access) from Chat providers (Claude Chat, OpenAI, LM Studio with direct API calls). Documents model selection rules and provider-specific behaviors. | Working on AI integration, adding new AI providers, modifying how models are selected, or debugging provider-specific issues. |
| [TRANSCRIPT_ARCHITECTURE.md](./docs/TRANSCRIPT_ARCHITECTURE.md) | Documents the two-tier transcript storage (raw messages -> canonical events), the TranscriptTransformer pipeline, per-provider parsers (ClaudeCodeRawParser, CodexRawParser), CanonicalEventDescriptor types, watermark-based processing, and mobile sync integration. | Working on transcript rendering, adding new parser support, debugging missing/duplicate events, modifying how raw messages are transformed, or understanding the canonical event pipeline. |
| [CONTEXT_WINDOW_USAGE_TRACKING.md](./docs/CONTEXT_WINDOW_USAGE_TRACKING.md) | Explains how context window fill percentage is extracted from Claude Agent SDK streaming chunks (per-step vs cumulative usage), compaction handling, and subagent isolation. | Working on context usage display, token tracking, ClaudeCodeProvider streaming, or debugging why context percentage is wrong. |
| [INTERNAL_MCP_SERVERS.md](./docs/INTERNAL_MCP_SERVERS.md) | Documents how to implement MCP servers that run inside Nimbalyst, including the server lifecycle, tool registration, and how to expose functionality to Claude Code sessions. | Adding new MCP server functionality, creating new tools for AI agents, or understanding how existing MCP servers work. |
| [CUSTOM_TOOL_WIDGETS.md](./docs/CUSTOM_TOOL_WIDGETS.md) | Explains how to create custom React widgets that replace the generic tool call display for specific MCP tools. Covers the widget registry, props interface, and rendering lifecycle. | Creating visual displays for MCP tool results, customizing how specific tools appear in the chat transcript, or debugging widget rendering issues. |
| [INTERACTIVE_PROMPTS.md](./docs/INTERACTIVE_PROMPTS.md) | Documents the durable prompts architecture for AskUserQuestion, ExitPlanMode, GitCommitProposal, and ToolPermission widgets. These prompts persist across page reloads and have special handling for user responses. | Working on interactive prompt widgets, adding new durable prompt types, or debugging why prompts aren't persisting or responding correctly. |
| [WORKTREES.md](./docs/WORKTREES.md) | Covers git worktree integration for isolated AI coding sessions. Documents the database schema, IPC channels, branch naming conventions, and how worktrees relate to sessions (one-to-many). | Working on worktree features, session isolation, or understanding how AI sessions connect to git worktrees. |
| [HELP_WALKTHROUGHS.md](./docs/HELP_WALKTHROUGHS.md) | Documents the HelpContent registry keyed by `data-testid`, HelpTooltip wrapper component, and walkthrough definitions for multi-step guides. Covers both hover tooltips and inline help icons. | Adding help tooltips to UI elements, creating new walkthrough guides, or modifying existing help content. |
| [REACT_DOM_MARKERS.md](./docs/REACT_DOM_MARKERS.md) | Defines the required semantic classname, `data-testid`, and optional `data-component`/`data-source` conventions for React UI. Includes examples and anti-patterns intended for AI agents and human contributors. | Working on React UI, adding new components, refactoring rendered DOM structure, or improving testability/devtools navigation. |
| [WALKTHROUGHS.md](./docs/WALKTHROUGHS.md) | Additional documentation on the walkthrough system including step definitions, positioning, and triggering conditions for multi-step floating guides. | Creating complex multi-step walkthroughs or debugging walkthrough flow issues. |
| [E2E_TESTING.md](./docs/E2E_TESTING.md) | Covers E2E testing patterns including test structure, selectors, waiting strategies, and common pitfalls. Documents the test utilities and how to handle async operations in tests. Also includes AI agent guidelines for when to run tests in dev containers and how to run targeted tests. | Writing new E2E tests, debugging flaky tests, understanding why tests are failing, or running E2E tests as an AI agent (especially in git worktrees). |
| [DIALOGS.md](./docs/DIALOGS.md) | Documents the DialogProvider system for modal dialogs including the dialog registry, opening/closing patterns, and how dialogs receive props and return results. | Adding new modal dialogs, modifying existing dialog behavior, or debugging dialog state issues. |
| [AGENT_PERMISSIONS.md](./docs/AGENT_PERMISSIONS.md) | Covers the tool permission system for AI agents including permission levels, approval flows, and how permissions are persisted and checked at runtime. | Working on agent permissions, adding new permission types, or debugging why tools are being blocked or auto-approved. |
| [ANALYTICS_GUIDE.md](./docs/ANALYTICS_GUIDE.md) | Documents how to add PostHog analytics events including event naming conventions, property schemas, and best practices. Required reading before using PostHog MCP tools. | Adding new analytics events, modifying existing events, or using the PostHog MCP tools for querying analytics. |
| [POSTHOG_EVENTS.md](./docs/POSTHOG_EVENTS.md) | Canonical reference listing all PostHog events with their names, file locations, triggers, and properties. Must be kept in sync when adding, modifying, or removing events. | Adding, modifying, or removing any PostHog analytics event. Update this file whenever you change events. |
| [POSTHOG_MCP_INTEGRATION.md](./docs/POSTHOG_MCP_INTEGRATION.md) | Documents the PostHog MCP server architecture, available tools, and how to query analytics data programmatically from AI sessions. | Using PostHog MCP tools to query analytics, debugging MCP integration issues, or extending PostHog functionality. |
| [THEMING.md](./packages/electron/docs/THEMING.md) | Documents the theming system including theme definition format, color variables, and how themes are applied across the application. | Working on themes, adding new color schemes, or debugging theme-related styling issues. |
| [RELEASING.md](./RELEASING.md) | Documents the release process including version bumping, changelog management, git tagging, and the `/release-alpha` plus `/promote-public-release` commands. Covers both alpha prereleases and stable promotion. | Preparing a release, understanding the release workflow, or debugging release script issues. |
| [MARKETING_SCREENSHOTS.md](./docs/MARKETING_SCREENSHOTS.md) | Documents the Playwright-based marketing screenshot and video capture system. Covers the fixture workspace, helper utilities, DOM cursor for video, output file inventory, and how to add new screenshots or video choreography. | Adding new marketing screenshots, modifying video choreography, updating the fixture workspace data, or importing output files into the marketing website. |
| [FILE_WATCHING_AND_CHANGE_TRACKING.md](./docs/FILE_WATCHING_AND_CHANGE_TRACKING.md) | Documents the file watching infrastructure (ChokidarFileWatcher, OptimizedWorkspaceWatcher, GitRefWatcher, SessionFileWatcher), AI change tracking pipeline (SessionFileTracker, HistoryManager, ToolCallMatcher), IPC event flow, Jotai atoms for file state, and the red/green diff display system (DiffPreview, TextDiffViewer, MonacoDiffViewer, DiffPreviewEditor). | Working on file watchers, AI change detection, diff display, pending review flow, snapshot storage, file change conflict handling, or the FilesEditedSidebar. |
| [WEEKLY_DASHBOARD.md](./docs/WEEKLY_DASHBOARD.md) | Rules for the PostHog "Weeklys" dashboard. All insights must query `WEEKLY_USERS_BASE_VIEW`, use stacked bar charts summing to 100%, and include all four user segments. Documents the new/returning split convention and example queries. | Adding or modifying insights on the Weeklys PostHog dashboard, or working with the `WEEKLY_USERS_BASE_VIEW` materialized view. |
| [VOICE_MODE.md](./docs/VOICE_MODE.md) | Documents the dual-agent voice mode architecture: OpenAI Realtime API for speech, coding agent for technical work. Covers the full data flow, IPC channels, Jotai atoms, listen state machine, session persistence, audio pipeline, settings, and MCP tool integration. | Working on voice mode features, modifying the voice agent system prompt, changing audio capture/playback, adding voice agent tools, debugging voice session lifecycle, or understanding how voice connects to coding sessions. |

## AI Features

- **AI Chat Panel**: Multi-provider support (Claude, OpenAI, LM Studio, Claude Code), document-aware, Cmd+Shift+A to toggle
- **Session Manager**: Global session view (Cmd+Alt+S), search, export, delete
- **Model Configuration**: Dynamic model selection from provider APIs, no hardcoded models
- **Git Worktrees**: Isolated AI coding sessions on separate branches via "New Worktree" button

## Data Persistence

The Nimbalyst app uses **PGLite** (PostgreSQL in WebAssembly) for all data storage.

**CRITICAL: Never use localStorage in the renderer process.** Use instead:
- **app-settings store** for global app settings
- **workspace-settings store** for per-project state
- **PGLite database** for complex data like AI sessions and document history

**CRITICAL: All database timestamps must use \****`TIMESTAMPTZ`**\*\*.** Never create `TIMESTAMP` (without timezone) columns. If legacy tables exist, add a migration to convert those columns to `TIMESTAMPTZ`.

For implementation details, see `/packages/electron/CLAUDE.md`.

## Canonical Transcript Storage

The AI transcript system uses a two-tier architecture. See [TRANSCRIPT_ARCHITECTURE.md](./docs/TRANSCRIPT_ARCHITECTURE.md) for the full design.

- **`ai_agent_messages`** -- Append-only raw source log preserving provider-native payloads. Sole source of truth.
- **`ai_transcript_events`** -- Canonical, provider-agnostic events derived from raw messages. Used for rendering, search, and sync.

**Key components** (in `packages/runtime/src/ai/server/transcript/`):
- **TranscriptTransformer** -- Single path from raw messages to canonical events. Batch mode (`ensureUpToDate`) for lazy migration on session load; incremental mode (`processNewMessages`) for real-time processing during streaming.
- **Per-provider parsers** (`parsers/ClaudeCodeRawParser`, `parsers/CodexRawParser`) -- Parse raw messages into `CanonicalEventDescriptor[]`. Parsers are pure functions; the transformer handles writing.
- **TranscriptWriter** -- Writes canonical events to DB. Called by the transformer only.
- **TranscriptProjector** -- Projects canonical events into UI view models.
- **TranscriptMigrationService** -- High-level API wrapping the transformer for IPC handlers.

**Rules:**
- All providers write only to `ai_agent_messages` (raw log) via `logAgentMessage()`; there is no dual-write
- The transformer is the single writer of canonical events -- no other code path writes to `ai_transcript_events`
- Watermark-based processing: only raw messages with `id > lastRawMessageId` are transformed
- Canonical events can be regenerated at any time by bumping `CURRENT_VERSION`
- Only `user_message`, `assistant_message`, and `system_message` events are searchable

## Decision Logging

When choosing between alternatives that affect more than the immediate task -- a library, an architecture pattern, an API design, or deciding NOT to do something -- log it as a **decision** tracker item using the `tracker_create` tool.

**When to log:**
- Choosing a library or dependency
- Picking an architecture pattern over alternatives
- Designing an API contract or data model
- Deciding NOT to do something (e.g., "we won't use Redux because...")
- Any choice where future-you would ask "why did we do it this way?"

**How to log:**

```
tracker_create({
  type: "decision",
  title: "{what you decided}",
  priority: "medium",  // or "high" for architectural decisions
  labels: ["{area}"],  // e.g., "extensions", "ai", "sync", "ui"
  description: `## Context\n{why this came up}\n\n## Alternatives considered\n{what else was on the table}\n\n## Reasoning\n{why this option won}\n\n## Trade-offs accepted\n{what you gave up}`
})
```

**Before making a similar decision**, search existing decisions with `tracker_list({ type: "decision", search: "{topic}" })`. Follow prior decisions unless new information invalidates the reasoning -- in which case, log a new decision that supersedes the old one and reference it.

## Bug Tracking

When fixing a bug, **always ensure a tracker bug item exists** before starting the fix. If the user hasn't already pointed you at an existing tracker item, create one immediately using `tracker_create`.

**Workflow:**
1. **Check for existing bug**: `tracker_list({ type: "bug", search: "{topic}" })` -- if one exists, link to it with `tracker_link_session`
2. **Create if missing**: If no tracker item exists, create one before writing any fix code
3. **Keep it updated**: Update the tracker item's status as you progress (`to-do` -> `in-progress` -> `in-review`)
4. **Link the session**: Always call `tracker_link_session` so the bug and session are cross-referenced

**How to create:**

```
tracker_create({
  type: "bug",
  title: "{concise description of the bug}",
  priority: "medium",  // or "high"/"critical" based on severity
  labels: ["{area}"],  // e.g., "ios", "electron", "sync", "ui"
  description: `## Symptoms\n{what the user sees}\n\n## Expected behavior\n{what should happen}\n\n## Root cause\n{fill in once diagnosed}\n\n## Fix\n{fill in once implemented}`
})
```

**As the fix progresses**, update the description with root cause and fix details using `tracker_update`. This creates a durable record of what was wrong and how it was fixed.

## General Development Guidelines

- **Never use emojis** - Not in commits, code, or documentation unless explicitly requested
- **Never use overly enthusiastic phrases** like "Perfect!", "Terrific!", etc.
- **Never commit changes unless explicitly asked**
- **Never commit files under `nimbalyst-local/`** - This directory contains local-only plans, diagrams, and working files that are never checked into git. Do not stage or include them in any commit.
- **Never provide time or effort estimates**
- **Don't disable tests without asking first**
- **Don't run \****`npm run dev`**\*\* yourself** - User always does that
- **Never release without being explicitly instructed**
- **Don't git reset or git add -A without asking**
- **Don't add Co-Authored-By lines to commit messages**
- **Never restart Nimbalyst without explicit permission** - Always ask before using `restart_nimbalyst`
- **Never mark work as done/completed without user approval** - When finishing a task, feature, or implementation, set tracker items to a review/validation state (e.g., `in-review`), NOT `done` or `completed`. Set session phase to `validating`, NOT `complete`. Only the user can approve moving work to `done`/`completed`/`complete`. This applies to tracker items, plan statuses, session phases, and any other status field. The agent's job is to implement and present for review -- the user decides when work is actually done.

**Keyboard Shortcuts**: When adding or modifying keyboard shortcuts, update `KeyboardShortcutsDialog.tsx` to keep the Help > Keyboard Shortcuts dialog in sync.

## Architecture Diagrams for Decisions

Whenever an architectural change or decision is made -- whether proposed by the human or the AI -- create an Excalidraw diagram to visualize it and show it to the user inline. This applies to decisions like:

- New module boundaries, data flow changes, or service decomposition
- Changes to IPC channels, state management patterns, or persistence layers
- New extension points, editor types, or provider integrations
- Database schema changes or migration strategies
- Significant refactors that alter how components relate to each other

**How to create the diagram:**

1. Create an `.excalidraw` file in `nimbalyst-local/architecture/` (e.g., `nimbalyst-local/architecture/transcript-refactor.excalidraw`)
2. Use the Excalidraw MCP tools to build a clear diagram showing the relevant components, their relationships, and data flow. Include:
   - Named boxes for each component, service, or module involved
   - Arrows showing data flow, IPC channels, or dependency direction
   - Labels on arrows describing what flows between components
   - A title or heading text element describing the decision
   - Color coding where helpful (e.g., green for new, red for removed, gray for unchanged)
3. Use `capture_editor_screenshot` to capture the diagram and show it inline in the conversation
4. Reference the diagram file path so the user can open and edit it later

The goal is that architectural decisions are always visually communicated, never just described in text. Diagrams should be clear enough that someone unfamiliar with the decision can understand the before/after or the proposed structure at a glance.

## Verifying Development Mode

**IMPORTANT**: Before making code changes to the Nimbalyst codebase, use `mcp__nimbalyst-extension-dev__get_environment_info` to verify that Nimbalyst is running in development mode. If the user is running a packaged build, your code changes will NOT take effect and you should inform them to start the dev server (`npm run dev`).

## Debugging with Log Access Tools

Agents have access to comprehensive logging tools. **Never ask users to copy-paste logs** - use these tools instead:

1. **get\_main\_process\_logs** - Main process log file (file system, IPC, AI providers)
2. **get\_renderer\_debug\_logs** - Renderer debug log file (UI errors, React components, console output)

**Debugging workflow:**
1. Check recent renderer logs: `get_renderer_debug_logs(lastLines: 100, logLevel: "error")`
2. Check main process: `get_main_process_logs(component: "FILE_WATCHER", logLevel: "error")`
3. Search for specific errors: `get_renderer_debug_logs(searchTerm: "TypeError", lastLines: 200)`
4. Investigate previous session crash: `get_renderer_debug_logs(session: 1, logLevel: "error")`

**When to use each tool:**
- **get\_main\_process\_logs**: File watcher issues, IPC errors, AI provider failures, database errors (persisted log file)
- **get\_renderer\_debug\_logs**: UI errors, React component issues, console output, crash investigation (dev mode only, persists across restarts)

## Support

User support documentation is located in the `support/` folder:
- **force-restore-database-backup.md**: Instructions for manually restoring the database from backup
