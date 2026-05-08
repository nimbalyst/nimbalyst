# IPC Guide for Nimbalyst

This document explains how inter-process communication (IPC) is organized in the Electron application that powers Nimbalyst. Use it as a reference when adding new platform features or debugging communication between the renderer and the main process.

## Architecture Overview

Nimbalyst runs as a typical secure Electron app:
- **Main process** (Node.js environment) manages application state, filesystem access, and window lifecycles. Its entry point is `packages/electron/src/main/index.ts`.
- **Preload script** (`packages/electron/src/preload/index.ts`) runs in an isolated context for every `BrowserWindow`. It exposes a curated `window.electronAPI` object via `contextBridge` so renderers never import `electron` directly.
- **Renderer** (React app in `packages/electron/src/renderer/`) consumes the safe API surface exported by the preload script and never touches Node globals.

This separation lets us keep `contextIsolation` enabled and maintain a small, auditable bridge between privileged and unprivileged code.

### Event Flow: Main → Renderer

```
┌─────────────────────────────────────────────────────────────┐
│                     Main Process                            │
│  (AI Provider, File Watcher, Git, etc.)                     │
└──────────────────────┬──────────────────────────────────────┘
                       │ IPC Events (webContents.send)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              Centralized IPC Listeners                      │
│  store/listeners/sessionListeners.ts                        │
│  store/listeners/fileStateListeners.ts                      │
│  store/listeners/gitListeners.ts                            │
└──────────────────────┬──────────────────────────────────────┘
                       │ store.set(atom, value)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    Jotai Atoms                              │
│  Per-session atoms (atom families)                          │
│  - sessionMessagesAtom(sessionId)                           │
│  - sessionPendingDialogsAtom(sessionId)                     │
│  - sessionFileEditsAtom(sessionId)                          │
└──────────────────────┬──────────────────────────────────────┘
                       │ useAtomValue()
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                   React Components                          │
│  Pure views that render atom state                          │
│  NO IPC subscriptions in components                         │
└─────────────────────────────────────────────────────────────┘
```

## Where IPC Handlers Live

Main-process IPC handlers are registered during `app.whenReady()` inside `packages/electron/src/main/index.ts`. Each capability is organized by feature:

- `src/main/ipc/` contains focused handler modules (`SettingsHandlers.ts`, `WindowHandlers.ts`, `SessionFileHandlers.ts`, etc.).
- `src/main/services/` modules expose richer APIs (for example, `AIService.ts` registers many `ai:*` channels).
- `src/main/window/` modules sometimes register window-specific channels (e.g., Session Manager export functions).

Every handler module exports a function that is invoked from `index.ts` (for example `registerSettingsHandlers()`). This keeps startup readable and makes it obvious which features have IPC coverage.

## Naming Conventions

- **Invoke-style requests** use `ipcMain.handle(channel, async () => …)` and are consumed through `ipcRenderer.invoke(channel, …)`. Return values resolve as Promises in the renderer.
- **Fire-and-forget events** use `ipcMain.on(channel, (event, payload) => …)` and correspond to `ipcRenderer.send(channel, payload)`.
- Channel names follow a `namespace:action` pattern (`'history:create-snapshot'`, `'session-files:get-by-session'`) to avoid collisions and to make debugging easier.
- Renderer-to-renderer broadcasts always go through the main process: `window.webContents.send('theme-change', theme)`.

## Preload Bridge Pattern

`packages/electron/src/preload/index.ts` mirrors the registered channels. Each bridge function:

1. Calls `ipcRenderer.invoke` or `ipcRenderer.send` with the relevant channel.
2. Returns a disposer when registering event listeners (e.g., `onThemeChange`).
3. Avoids exposing raw `ipcRenderer` to renderers.

When you add a new handler in the main process, add a matching function in the preload script and update `packages/electron/src/renderer/electron.d.ts` so TypeScript consumers get accurate typings.

```ts
// preload
contextBridge.exposeInMainWorld('electronAPI', {
  doThing: (input: string) => ipcRenderer.invoke('my-feature:do-thing', input),
  onThingCompleted: (cb: (result: Result) => void) => {
    const handler = (_event, result) => cb(result);
    ipcRenderer.on('my-feature:completed', handler);
    return () => ipcRenderer.removeListener('my-feature:completed', handler);
  }
});
```

```ts
// renderer usage
const outcome = await window.electronAPI.doThing('hello');
const unsubscribe = window.electronAPI.onThingCompleted((result) => {
  console.log('Result arrived', result);
});
```

## Renderer Event Consumption (Centralized Listeners)

**CRITICAL: React components NEVER subscribe to IPC events directly.**

All IPC event handling follows a centralized architecture where:
1. **Central listeners** subscribe to IPC events ONCE at app startup
2. **Listeners update Jotai atoms** when events fire (with debouncing where appropriate)
3. **Components read from atoms** using `useAtomValue()` and re-render automatically

This pattern prevents:
- Race conditions when switching contexts (session, workspace, etc.)
- Stale closures capturing old component state
- MaxListenersExceededWarning from N components subscribing to the same event
- Memory leaks from forgotten cleanup

### Where Listeners Live

Central listeners are organized by domain in `store/listeners/`:

| File | Events Handled |
|------|----------------|
| `sessionListeners.ts` | Session lifecycle: started, completed, processing |
| `sessionListListeners.ts` | Session list updates (with 150ms debouncing) |
| `fileStateListeners.ts` | `session-files:updated`, `git:status-changed`, `history:pending-count-changed` |

### Adding a New Event Listener

1. **Identify the appropriate listener file** (or create one in `store/listeners/`)
2. **Add the event handler** that updates the relevant atom
3. **Create or update atoms** in `store/atoms/` as needed
4. **Initialize the listener** in `AgentMode.tsx` or the appropriate top-level component

**Example - Adding a new confirmation dialog:**

```typescript
// 1. Add atom in store/atoms/sessionDialogs.ts
export const sessionPendingFooAtom = atomFamily((sessionId: string) =>
  atom<FooData | null>(null)
);

// 2. Add listener in store/listeners/sessionDialogListeners.ts
export function initSessionDialogListeners(): () => void {
  const cleanups: Array<() => void> = [];

  cleanups.push(
    window.electronAPI.on('ai:fooConfirm', (data) => {
      store.set(sessionPendingFooAtom(data.sessionId), data);
    })
  );

  cleanups.push(
    window.electronAPI.on('ai:fooResolved', (data) => {
      store.set(sessionPendingFooAtom(data.sessionId), null);
    })
  );

  return () => cleanups.forEach(fn => fn?.());
}

// 3. Component just reads the atom - no IPC subscription!
function MyComponent({ sessionId }: { sessionId: string }) {
  const pendingFoo = useAtomValue(sessionPendingFooAtom(sessionId));
  if (pendingFoo) return <FooDialog data={pendingFoo} />;
  return null;
}
```

### Anti-Patterns (NEVER do these)

| Don't Do This | Do This Instead |
|---------------|-----------------|
| `window.electronAPI.on()` in component | Add listener to `store/listeners/` |
| `useEffect` with IPC subscription | Read from atom via `useAtomValue()` |
| Local `useState` synced from IPC events | Atom updated by central listener |
| `useIPCListener` hook in component | Central listener + atom |

**If you think you need a component-local IPC listener:**
1. You probably don't - rethink the architecture
2. If truly necessary, add explicit ESLint disable with justification comment
3. Consider whether this should be a new centralized listener instead

### Why This Architecture?

- **One listener per event** - Not N listeners for N component instances
- **No listener churn** - Components re-render freely without affecting subscriptions
- **No stale closures** - Atoms always have current state
- **Components are pure views** - Easier to reason about and test
- **Multi-window works automatically** - Atoms sync across windows via store

## Renderer → Main Communication

React components and hooks import nothing from Electron directly. They call `window.electronAPI` helpers and wrap them in domain-specific services (see `src/renderer/services/aiApi.ts`). Keep these helpers thin so testing remains straightforward.

When invoking IPC from the renderer:

- Always `await` invoke calls and handle failures gracefully (`try/catch`).
- Debounce high-frequency sends (like resizing) before sending to the main process.

## Workspace-Scoped IPC: `workspacePath` is Required

**CRITICAL: Workspace-scoped IPC handlers MUST take `workspacePath` as a required parameter.**

Nimbalyst is multi-window: every workspace runs in its own `BrowserWindow`. Any IPC channel that operates on workspace-scoped data (sessions, files, trackers, worktrees, project state, etc.) MUST receive `workspacePath` from the renderer as an explicit argument. The renderer always knows its window's workspace — pass it.

Main-process handlers and services MUST NOT fall back to module-level "current workspace" state (e.g. a `currentWorkspacePath` field on a singleton service). That state is shared across all windows and last-write-wins between them: whichever window most recently set it wins, and other windows silently get the wrong workspace context. Symptoms include:

- Cross-window session/data pollution
- Validator warnings like `[SessionManager] Rejecting session ...: belongs to /path/A, not /path/B`
- Tabs in window A briefly showing data from window B
- "Works fine until I open a second window" bugs

**Carve-out:** genuinely app-global channels (theme, app settings, app version, analytics consent, update checks) don't need a workspace.

**If you can't decide whether a channel is workspace-scoped, it is.** The default must be "scoped + required parameter."

### Pattern

```ts
// preload
contextBridge.exposeInMainWorld('electronAPI', {
  doWorkspaceThing: (workspacePath: string, ...args: unknown[]) =>
    ipcRenderer.invoke('feature:do-thing', workspacePath, ...args),
});

// main handler -- workspacePath is required and validated up-front
safeHandle('feature:do-thing', async (event, workspacePath: string, ...args) => {
  if (!workspacePath) {
    throw new Error('feature:do-thing requires workspacePath');
  }
  return await service.doThing(workspacePath, ...args);
});

// service -- never falls back to a stored "current" workspace
async doThing(workspacePath: string, ...args: unknown[]) {
  // workspace is the parameter, full stop
}
```

### Anti-pattern

```ts
// WRONG: handler doesn't carry workspace
safeHandle('session:load', async (event, sessionId) => {
  return await sessionManager.loadSession(sessionId);
  // falls back to a module-level currentWorkspacePath that any other
  // window may have just clobbered. Cross-window pollution waiting to happen.
});

// WRONG: service caches "current workspace" and uses it as a fallback
class SessionManager {
  private currentWorkspacePath: string | null = null;

  async loadSession(sessionId: string, workspacePath?: string) {
    const ws = workspacePath || this.currentWorkspacePath; // BUG
    // ...
  }
}
```

Existing handlers that omit `workspacePath` are bugs to fix incrementally -- not patterns to copy. When you touch a workspace-scoped handler that lacks it, add it.

### Resolving from `event.sender` is a fallback, not the rule

For legacy channels where the preload signature is locked, you can resolve the workspace from the calling window via `BrowserWindow.fromWebContents(event.sender)` -> `getWindowId(...)` -> `windowStates.get(windowId).workspacePath`. But prefer making it an explicit parameter -- explicit beats implicit, and renderer code that has the path on hand should send it.

## Adding a New IPC Flow

### Request/Response (Renderer → Main → Renderer)

1. **Define the main handler.** Choose the file that owns the feature (create a new module under `src/main/ipc/` if necessary). Use `ipcMain.handle` for request/response. Validate inputs and prefer returning structured objects (`{ success, data?, error? }`). If the channel is workspace-scoped, take `workspacePath` as a required parameter (see [Workspace-Scoped IPC](#workspace-scoped-ipc-workspacepath-is-required) above).
2. **Expose it through the preload bridge.** Add a function in `src/preload/index.ts` that invokes the new channel.
3. **Type it.** Update `src/renderer/electron.d.ts` so `window.electronAPI` reflects the new capability.
4. **Call it from the renderer.** Use the bridge helper inside your React code or service layer.

### Event Broadcasting (Main → Renderer)

1. **Send from main process.** Use `browserWindow.webContents.send('channel', payload)` to broadcast to renderers.
2. **Expose listener in preload bridge.** Add an `on` function that returns a cleanup disposer.
3. **Add centralized listener.** Create or update a listener file in `store/listeners/` that subscribes to the event and updates atoms.
4. **Initialize listener.** Call the init function at app startup (typically in `AgentMode.tsx`).
5. **Components read atoms.** Use `useAtomValue()` to read the updated state - never subscribe directly.

## Debugging Tips

- **Restart the dev server** after adding new IPC handlers or modifying preload scripts to ensure changes take effect.
  These file are not hot-reloaded.
- **Check the channel name** on both sides—typos are the most common source of `undefined` results.
- **Ensure a return statement** inside `ipcMain.handle` callbacks. If you forget to `return`, `ipcRenderer.invoke` resolves to `undefined`.
- **Use DevTools**: run `await window.electronAPI.invoke('channel', …)` from the console to inspect responses.
- **Log with context**: `logger.main` in the main process and `logger.ui` / `console` in renderers make correlation easier.
- **Profile payload size**: avoid sending very large blobs through IPC; use shared files when possible.

## Security Considerations

- Keep the preload surface minimal; exposing a single generic `invoke(channel, …)` helper is intentional, but **do not** leak Node primitives or unsanitized user input to the main process.
- Validate arguments in the main handler before touching the filesystem or executing shell commands.
- Prefer whitelisting operations instead of passing through arbitrary channel names from the renderer.

Following this pattern keeps Nimbalyst's IPC predictable, testable, and secure while still letting features evolve quickly.

## Related Documentation

- **CLAUDE.md** - Contains the authoritative "Centralized IPC Listener Architecture" section with implementation patterns
- **JOTAI.md** - Jotai atom patterns for state management
- `plans/centralized-ipc-listener-architecture.md` - Original design document for the centralized listener pattern
