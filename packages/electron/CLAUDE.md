# Electron Package

The Nimbalyst desktop app, built with Electron.

## Development Commands

- **Dev server**: `npm run dev` (user runs this — don't do it yourself)
- **Dev with restart loop**: `npm run dev:loop` (enables restart button / `/restart` command)
- **Build for Mac**: `npm run build:mac:local` or `npm run build:mac:notarized`

### Testing

From the repository root:
- Run one spec: `npx playwright test e2e/monaco/file-watcher-updates.spec.ts`
- Run a directory: `npx playwright test e2e/monaco/`
- Run all: `npx playwright test`

**Always use `npx playwright test` directly.** Never use parallel execution — it corrupts PGLite. See [/docs/E2E_TESTING.md](/docs/E2E_TESTING.md).

## Architecture

### Main and Renderer Processes

Electron apps split into two contexts:
- **Main** runs Node.js, manages lifecycle, windows, menus, system interactions.
- **Renderer** runs in a Chromium context; UI only.

Renderers cannot access Node.js APIs directly — use IPC to request main-process services. For initialization rules (dynamic import in `bootstrap.ts`, lazy init for `app.getPath()` consumers, `safeHandle` / `safeOn`), and cross-platform code patterns, see [MAIN_PROCESS_INIT.md](./MAIN_PROCESS_INIT.md).

## IPC Communication

### Preload API
- **Location**: `src/preload/index.ts`
- **Exposed as**: `window.electronAPI` (NOT `window.api`)
- **Generic methods**: `invoke`, `send`, `on` (returns an unsubscribe closure — there is no `off`, see [/docs/IPC_LISTENERS.md](/docs/IPC_LISTENERS.md))
- Renderer services use these to talk to main-process services.

### Document Service
- Main: `ElectronDocumentService` (file scanning, metadata extraction, caching)
- Renderer: `RendererDocumentService` (facade over IPC)
- **Metadata**: frontmatter extraction with bounded reads (4KB)
- **Channels**: `document-service:*`

### Common IPC Issues
- `window.api undefined` → use `window.electronAPI`
- Empty responses → check the window has a valid workspace path
- Service resolution is keyed off workspace path

For deep IPC patterns (`safeHandle`/`safeOn`, error handling, channel structure), see [/docs/IPC_GUIDE.md](/docs/IPC_GUIDE.md).

## Data Persistence

The app runs over **either PGLite (PostgreSQL in WebAssembly) or better-sqlite3** — both backends are active during the in-progress migration. Code must work on either; do not assume one. **Never use `localStorage` in the renderer.** Persist via IPC to main using:
- **app-settings store** (`src/main/utils/store.ts`) for global app settings
- **workspace-settings store** for per-project state
- **AppDatabase** (PGLite or SQLite, selected at init) for complex data (AI sessions, document history, trackers)

The biggest divergence to remember: `data->'key'` returns a parsed object on PGLite but a JSON string on SQLite. For tables, locations, shutdown rules, timestamp handling, and the full list of backend-divergent behaviors, see [DATABASE.md](./DATABASE.md).

## Renderer State Architecture

The renderer uses Jotai for state that crosses component boundaries. Editors use **EditorHost** — a stable service object — for all host communication; content state lives in the editor, not parent components.

| Domain | Atoms | Owner |
| --- | --- | --- |
| Theme | `themeAtom` | Global, IPC-synced |
| Editors | `editorDirtyAtom(key)`, `editorProcessingAtom(key)` | EditorHost writes, Tab reads |
| Sessions | `sessionUnreadAtom(id)`, `sessionProcessingAtom(id)` | AgenticPanel writes, UI reads |
| File Tree | `gitStatusAtom`, `expandedDirsAtom` | WorkspaceSidebar writes, FileTree reads |
| Trackers | `trackerCountsAtom` | TrackerService writes, UI reads |

**Re-render isolation**: parents subscribe to lists of IDs; children subscribe to their own atoms. If you need `React.memo` to prevent re-renders, you have the wrong architecture.

For full patterns, see [/docs/EDITOR_STATE.md](/docs/EDITOR_STATE.md) and [/docs/JOTAI.md](/docs/JOTAI.md).

## Logging

Three log destinations:

- **Main process log**: `~/Library/Application Support/@nimbalyst/electron/logs/main.log` — main-process events, AI, sync, file ops; categories like `(MAIN)`, `(AI)`, `(API)`, `(SYNC)`.
- **Renderer console log** (dev mode only): `~/Library/Application Support/@nimbalyst/electron/nimbalyst-debug.log` — captured via `webContents.on('console-message')` in `src/main/index.ts`.

Use the agent log access tools (`get_main_process_logs`, `get_renderer_debug_logs`) instead of asking users to paste logs. See [/docs/DEBUGGING_LOGS.md](/docs/DEBUGGING_LOGS.md).

## Window State Persistence

- **Global session state** restores all windows on restart (bounds, focus order, dev tools state).
- **Per-project state** restores window configuration, open file, AI panel width and collapsed state, draft inputs.
- **Session continuity** — chat sessions persist across restarts.

## Theme Support

Themes: Light, Dark (#2d2d2d / #1a1a1a / #3a3a3a), Crystal Dark (Tailwind gray scale), Auto.

**Critical rules:**
- Never hardcode colors in CSS files — use CSS variables.
- `src/renderer/index.css` is the only place theme colors are defined.
- Apply themes by setting both the `data-theme` attribute and the CSS class on the root element.

Comprehensive: [THEMING.md](./THEMING.md).

## File Operations

- **Drag-and-drop**: move files/folders in the Project Sidebar; hold Option/Alt to copy.
- **Context menus**: rename, delete, open in new window.
- **File watching**: auto-update on disk changes.

## AI Providers

Provider implementations live in `packages/runtime` — see `/packages/runtime/CLAUDE.md`. Electron-only pieces:

- **Renderer panels**: `src/renderer/components/AIModels/panels/ClaudePanel.tsx`, `ClaudeCodePanel.tsx`
- **Claude Code installer**: `src/renderer/components/AIModels/services/CLIInstaller.ts` (manages local installation of `@anthropic-ai/claude-agent-sdk`)

## macOS Code Signing & Notarization

- **Certificate**: Developer ID Application
- **Builds**: `npm run build:mac:notarized` (notarized), `build:mac:local` (local testing)
- **Bundled tools**: ripgrep is signed; JAR files are excluded automatically (can't be notarized)
- **Entitlements**: hardened runtime with necessary exceptions

## Git Worktree Integration

Nimbalyst creates git worktrees for isolated AI coding sessions. See [/docs/WORKTREES.md](/docs/WORKTREES.md). The `worktrees` table stores metadata; `ai_sessions.worktree_id` links sessions to worktrees. IPC channels: `worktree:create`, `worktree:get-status`, `worktree:delete`, `worktree:list`, `worktree:get`.

## Analytics

See [/docs/ANALYTICS_GUIDE.md](/docs/ANALYTICS_GUIDE.md). **When adding, modifying, or removing PostHog events, update [/docs/POSTHOG_EVENTS.md](/docs/POSTHOG_EVENTS.md).**
