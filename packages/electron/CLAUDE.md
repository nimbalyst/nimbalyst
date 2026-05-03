# Electron Package

This package contains the Nimbalyst desktop application built with Electron.

## Development Commands

- **Start dev server**: `npm run dev` - Runs Electron app with hot reload
- **Start dev server loop**: `npm run dev:loop` - Runs Electron with hot reload and enables restart by restart button or /restart command
- **Build for Mac**: `npm run build:mac:local` - Creates local Mac build
- **Build for Mac (notarized)**: `npm run build:mac:notarized` - Creates notarized Mac build

### Testing

From the repository root:
- **Run specific test file**: `npx playwright test e2e/monaco/file-watcher-updates.spec.ts`
- **Run tests in a directory**: `npx playwright test e2e/monaco/`
- **Run all E2E tests**: `npx playwright test`

**IMPORTANT**: Always use `npx playwright test` directly for E2E tests. Never use parallel execution as it corrupts PGLite.

See `/docs/E2E_TESTING.md` for comprehensive E2E testing documentation.

## Architecture

### Main and Renderer Processes

Electron apps are split into two main contexts:
- **Main process**: Runs Node.js, manages application lifecycle, windows, menus, and system interactions
- **Renderer process**: Runs in a Chromium browser context, handles UI rendering and user interactions

Whenever working in the main process, use NodeJS APIs to write platform-independent code. This is crucial because we target Windows, macOS, and Linux.

Example:
```typescript
// GOOD: Cross-platform path handling
import * as path from 'path';
const fileName = path.basename(filePath, '.md');

// BAD: Hardcoded path separators
const fileName = filePath.split('/').pop()?.replace('.md', '');
```

Renderer processes cannot access Node.js APIs directly for security reasons. Use IPC to request services from the main process instead.

## IPC Communication

### Preload API
- **Location**: `src/preload/index.ts`
- **Exposed as**: `window.electronAPI` (NOT `window.api`)
- **Generic IPC methods**: `invoke`, `send`, `on`, and `off` for flexible service communication
- **Service pattern**: Renderer services use these generic methods to communicate with main process services

### Document Service
- **Main process**: `ElectronDocumentService` handles file scanning, metadata extraction, and caching
- **Renderer process**: `RendererDocumentService` acts as a facade, using IPC to communicate with main
- **Metadata API**: Supports frontmatter extraction and caching for all markdown documents with bounded file reads (4KB)
- **IPC channels**: `document-service:*` for all document-related operations

### Common IPC Issues
- **window.api undefined**: Use `window.electronAPI`, not `window.api`
- **Empty responses**: Check that window state has a valid workspace path
- **Service resolution**: Main process resolves services based on workspace path

## Main Process Initialization

The Electron main process has specific initialization constraints that must be respected:

### Bootstrap and Dynamic Import

`bootstrap.ts` is the entry point and uses a dynamic import for `index.ts`:
```typescript
import('./index.js');  // Dynamic, not static!
```

**Why dynamic import is required:**
1. `NODE_PATH` must be set before `node-pty` can be resolved in packaged builds
2. Static imports are resolved before any code runs
3. Dynamic import defers loading until after `NODE_PATH` is configured

**Never change this to a static import** - it will break packaged builds.

### Lazy Initialization Pattern

Singletons that read `app.getPath()` must use lazy initialization:

```typescript
// BAD: Reads userData path at module load time
const store = new Store({ name: 'settings' });

// GOOD: Defers until first access
let _store: Store | null = null;
function getStore() {
  if (!_store) {
    _store = new Store({ name: 'settings' });
  }
  return _store;
}
```

This ensures `app.setPath('userData')` in bootstrap.ts takes effect.

### IPC Handler Registration

Use `safeHandle`/`safeOn` from `ipcRegistry.ts` instead of `ipcMain.handle`/`ipcMain.on`:

```typescript
// BAD: Crashes if handler already registered
ipcMain.handle('my-channel', handler);

// GOOD: Safe for duplicate registration
safeHandle('my-channel', handler);
```

This prevents "second handler" errors from module duplication across chunk boundaries.

## Data Persistence

The app uses **PGLite** (PostgreSQL in WebAssembly) for all data storage.

**CRITICAL: Never use localStorage in the renderer process.** All persistent state must be stored via IPC to the main process using either:
- **app-settings store** (`src/main/utils/store.ts`) for global app settings
- **workspace-settings store** for per-project state
- **PGLite database** for complex data like AI sessions and document history

### Database System
- **Technology**: PGLite running in Node.js worker thread
- **Storage**: Persistent file-based database with ACID compliance
- **Worker architecture**: Isolated worker thread prevents module conflicts
- **Bundling**: PGLite is fully bundled in packaged apps

### Database Tables
- **ai\_sessions**: AI chat conversations with full message history, document context, and provider configurations
- **app\_settings**: Global application settings (theme, providers, shortcuts, etc.)
- **project\_state**: Per-project state including window bounds, UI layout, open tabs, file tree, and editor settings
- **session\_state**: Global session restoration data for windows and focus order
- **document\_history**: Compressed document edit history with binary content storage

### Data Locations (macOS)
- **Database**: `~/Library/Application Support/@nimbalyst/electron/pglite-db/`
- **Logs**: `~/Library/Application Support/@nimbalyst/electron/logs/`
- **Debug log**: `~/Library/Application Support/@nimbalyst/electron/nimbalyst-debug.log`
- **Legacy files**: `~/Library/Application Support/@nimbalyst/electron/history/` (preserved after migration)

### Database Features
- **Compression**: Document history stored as compressed binary data (BYTEA)
- **JSON support**: Rich JSON fields for complex data structures (JSONB columns)
- **Indexing**: Optimized indexes for fast queries on projects, timestamps, and file paths
- **Protocol server**: Optional PostgreSQL protocol server for external database access

### CRITICAL: App Shutdown and Database Integrity

**NEVER use `app.exit()` to terminate the app.** It bypasses the `before-quit` handler in `index.ts`, skipping database backup and PGLite worker shutdown, which causes database corruption.

Always use `app.quit()` to trigger proper cleanup. For programmatic restarts:

```typescript
// Dev mode: write signal file, let dev-loop.sh handle restart
fs.writeFileSync(path.join(app.getAppPath(), '.restart-requested'), Date.now().toString());
app.quit();

// Production: use relaunch + quit
app.relaunch();
app.quit();
```

Dev mode requires the signal file because `app.relaunch()` doesn't work when electron-vite spawns both Vite and Electron processes.

### CRITICAL: Date/Timestamp Handling

All timestamp columns use TIMESTAMPTZ (timestamp with time zone). With TIMESTAMPTZ, PGLite returns Date objects that already represent the correct instant in time.

**Rules when working with database timestamps:**

1. **DO**: Use TIMESTAMPTZ for all timestamp columns (not TIMESTAMP without timezone)

2. **DO**: Pass Date objects directly when writing to TIMESTAMPTZ columns
```typescript
db.query('INSERT INTO ... VALUES ($1)', [new Date()])
```

3. **DO**: Retrieve timestamps through `toMillis()` function
```typescript
const createdAt = toMillis(row.created_at)!;              // Required timestamp
const claimedAt = toMillis(row.claimed_at) ?? undefined;  // Nullable timestamp
```

4. **DO**: Display with `toLocaleString()` for user's local timezone

**Related files:**
- `src/main/database/worker.js` - Database schema and comments
- `src/main/utils/timestampUtils.ts` - canonical toMillis() implementation

## Renderer State Architecture

### Jotai Atoms by Domain

The renderer uses Jotai for state that needs to cross component boundaries:

| Domain | Atoms | Owner |
| --- | --- | --- |
| Theme | `themeAtom` | Global, IPC-synced |
| Editors | `editorDirtyAtom(key)`, `editorProcessingAtom(key)` | EditorHost writes, Tab reads |
| Sessions | `sessionUnreadAtom(id)`, `sessionProcessingAtom(id)` | AgenticPanel writes, UI reads |
| File Tree | `gitStatusAtom`, `expandedDirsAtom` | WorkspaceSidebar writes, FileTree reads |
| Trackers | `trackerCountsAtom` | TrackerService writes, UI reads |

### EditorHost Architecture

All editors use EditorHost - a stable service object that handles all host communication:

```typescript
// TabEditor creates host once, passes to editor
function TabEditor({ editorKey }: { editorKey: EditorKey }) {
  const host = useMemo(() => createEditorHost({ editorKey }), [editorKey]);
  const Editor = useEditorForFile(host.filePath);
  return <Editor host={host} />;
}

// Editor uses host for everything
function CustomEditor({ host }: { host: EditorHost }) {
  useEffect(() => host.loadContent().then(setContent), [host]);
  useEffect(() => host.onThemeChanged(setTheme), [host]);
  useEffect(() => host.onFileChanged(handleFileChange), [host]);
  useEffect(() => host.onSaveRequested(handleSave), [host]);

  const handleChange = (content) => {
    setContent(content);
    host.setDirty(true);  // Writes to atom, Tab re-renders, TabEditor does NOT
  };
}
```

**Key principle:** EditorHost methods write to atoms. Components that need that state subscribe to the atoms directly. The parent (TabEditor) never subscribes, so it never re-renders.

### Re-render Isolation

Parents subscribe ONLY to lists of IDs. Children subscribe to their own atoms:

```typescript
// TabBar subscribes to list of tab IDs only
function TabBar() {
  const tabIds = useAtomValue(tabIdsAtom);  // Re-renders when tabs added/removed
  return tabIds.map(id => <Tab key={id} editorKey={id} />);
}

// Each Tab subscribes to its own dirty atom
function Tab({ editorKey }) {
  const isDirty = useAtomValue(editorDirtyAtom(editorKey));  // Only THIS tab re-renders
  return <div>{isDirty && '*'}</div>;
}
```

**If you need React.memo to prevent re-renders, you have the wrong architecture.**

## Logging

The Electron app has multiple log outputs:

### Main Process Logs
- **Location**: `~/Library/Application Support/@nimbalyst/electron/logs/main.log` (macOS)
- **View live**: `tail -f ~/Library/Application\ Support/@nimbalyst/electron/logs/main.log`
- **What's logged**: Main process events, AI service, sync operations, file operations
- **Categories**: `(MAIN)`, `(AI)`, `(API)`, `(SYNC)`, etc.

### Renderer Console Logs
- **Location**: `~/Library/Application Support/@nimbalyst/electron/nimbalyst-debug.log` (macOS)
- **What's logged**: Browser console messages from renderer process
- **When active**: Only in development mode (`NODE_ENV !== 'production'`)
- **Implementation**: `src/main/index.ts` - uses `webContents.on('console-message')`

### Quick Debug Commands
```bash
# Watch main process logs live
tail -f ~/Library/Application\ Support/@nimbalyst/electron/logs/main.log

# Search for specific events
grep "queuedPrompts\|index_broadcast" ~/Library/Application\ Support/@nimbalyst/electron/logs/main.log | tail -50

# Watch sync-related logs
tail -f ~/Library/Application\ Support/@nimbalyst/electron/logs/main.log | grep -E "CollabV3|Sync"
```

## Window State Persistence

### Session State
- **Global session state**: Restores all windows when the app restarts
- **Window position and size**: Each window's bounds are saved and restored
- **Focus order**: Windows are restored in the correct stacking order
- **Developer tools state**: Dev tools are reopened if they were open when the window was closed

### Project-Specific State
- **Per-project window state**: Each project remembers its own window configuration
- **Persistent across sessions**: Opening a project restores its last window position, size, and dev tools state
- **File state**: Remembers which file was open in each project window

### AI Chat Integration
- **Panel width persistence**: The AI Chat panel width is saved per-window
- **Collapsed state**: Whether the AI Chat panel is visible or hidden is remembered
- **Draft input persistence**: Unsent messages in the chat input are saved with the session
- **Session continuity**: Chat sessions persist across app restarts

## Theme Support

The editor supports multiple themes:
- **Light**: Clean, bright theme for daytime use
- **Dark**: Standard dark theme with warm gray colors (#2d2d2d, #1a1a1a, #3a3a3a)
- **Crystal Dark**: A premium dark theme with Tailwind gray scale colors (#0f172a, #020617, #1e293b)
- **Auto**: Follows system preference

The Electron app includes a Window > Theme menu to switch between all themes. The selected theme is persisted and applied to all windows.

### CRITICAL THEMING RULES
- **NEVER hardcode colors in CSS files** - Always use CSS variables
- **Single source of truth**: `src/renderer/index.css` is the ONLY place where theme colors are defined
- **Always set both**: When applying themes, set both `data-theme` attribute AND CSS class on root element
- **See THEMING.md**: Comprehensive theming documentation at `/packages/electron/THEMING.md`

## File Operations

### Project Sidebar
- **Drag and drop**: Move files and folders via drag and drop
- **Copy on drag**: Hold Option/Alt while dragging to copy instead of move
- **Visual feedback**: Drop targets are highlighted during drag operations
- **Automatic renaming**: Copied files get unique names to avoid conflicts

### File Tree Features
- **Context menus**: Right-click files for rename, delete, open in new window
- **File watching**: Automatic updates when files change on disk
- **Recent files**: Quick access to recently opened files in projects

## AI Provider Implementation Details

### Key Files for Claude Providers
- **Claude API Provider**:
  - Main implementation: `packages/runtime/src/ai/server/providers/ClaudeProvider.ts`
  - UI panel: `src/renderer/components/AIModels/panels/ClaudePanel.tsx`
  - Uses Anthropic SDK directly with API key authentication
  - Supports model selection from predefined list in `packages/runtime/src/ai/modelConstants.ts`

- **Claude Code Provider**:
  - Implementation: `packages/runtime/src/ai/server/providers/ClaudeCodeProvider.ts`
  - UI panel: `src/renderer/components/AIModels/panels/ClaudeCodePanel.tsx`
  - Installation manager: `src/renderer/components/AIModels/services/CLIInstaller.ts`
  - Requires separate installation of `@anthropic-ai/claude-agent-sdk` package
  - Dynamically loads SDK from user's installation

### Provider Factory
- Location: `packages/runtime/src/ai/server/ProviderFactory.ts`
- Creates and manages provider instances based on type
- Provider types: `claude`, `claude-code`, `openai`, `openai-codex`, `lmstudio`
- Each provider is cached per session for efficiency

## macOS Code Signing & Notarization

The Electron app supports notarized distribution for macOS:

- **Signing configuration**: Uses Developer ID Application certificate
- **Build scripts**: `npm run build:mac:notarized` for notarized build, `build:mac:local` for local testing
- **Binary handling**: Properly signs ripgrep and other bundled tools
- **JAR exclusion**: Automatically removes JAR files that can't be notarized
- **Entitlements**: Configured for hardened runtime with necessary exceptions

## Git Worktree Integration

Nimbalyst supports creating git worktrees for isolated AI coding sessions. See [/docs/WORKTREES.md](/docs/WORKTREES.md) for comprehensive documentation.

### Database Schema
- `worktrees` table: Stores worktree metadata (id, workspace_id, name, path, branch, base_branch)
- `ai_sessions.worktree_id`: Foreign key linking sessions to worktrees (nullable)

### IPC Channels
- `worktree:create` - Create new worktree
- `worktree:get-status` - Get git status (ahead/behind, uncommitted changes)
- `worktree:delete` - Delete worktree
- `worktree:list` - List all worktrees for workspace
- `worktree:get` - Get single worktree by ID

## Testing

E2E tests use Playwright. See `/docs/E2E_TESTING.md` for comprehensive testing documentation.

**Key testing patterns:**
- Always create test files BEFORE launching the app
- Use manual save utilities instead of keyboard shortcuts
- Use AI Tool Simulator utilities for testing AI features
- Add `data-testid` attributes to new UI components

## Analytics

See `/docs/ANALYTICS_GUIDE.md` for details on adding anonymous usage analytics.

**IMPORTANT**: When adding, modifying, or removing PostHog events, you MUST update `/docs/POSTHOG_EVENTS.md` with the event name, file location, trigger, and properties.
