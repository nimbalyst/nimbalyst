# Electron Main Process Initialization

The Electron main process has specific initialization constraints that must be respected.

## Bootstrap and Dynamic Import

`bootstrap.ts` is the entry point and uses a dynamic import for `index.ts`:

```typescript
import('./index.js');  // Dynamic, not static!
```

**Why dynamic import is required:**
1. `NODE_PATH` must be set before `node-pty` can be resolved in packaged builds.
2. Static imports are resolved before any code runs.
3. Dynamic import defers loading until after `NODE_PATH` is configured.

**Never change this to a static import** — it will break packaged builds.

This is the only place dynamic imports are allowed in the main process. See the root CLAUDE.md "No Dynamic Imports in Electron Main Process" rule for context — everywhere else uses static top-level imports.

## Lazy Initialization Pattern

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

This ensures `app.setPath('userData')` in `bootstrap.ts` takes effect.

## IPC Handler Registration

Use `safeHandle` / `safeOn` from `ipcRegistry.ts` instead of `ipcMain.handle` / `ipcMain.on`:

```typescript
// BAD: Crashes if handler already registered
ipcMain.handle('my-channel', handler);

// GOOD: Safe for duplicate registration
safeHandle('my-channel', handler);
```

This prevents "second handler" errors from module duplication across chunk boundaries.

## Cross-Platform Code

Whenever working in the main process, use NodeJS APIs to write platform-independent code. We target Windows, macOS, and Linux.

```typescript
// GOOD: Cross-platform path handling
import * as path from 'path';
const fileName = path.basename(filePath, '.md');

// BAD: Hardcoded path separators
const fileName = filePath.split('/').pop()?.replace('.md', '');
```

Renderer processes cannot access Node.js APIs directly for security reasons. Use IPC to request services from the main process instead.
