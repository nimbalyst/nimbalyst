# Centralized IPC Listener Architecture

**CRITICAL: Never call `window.electronAPI.on(...)` from inside a React lifecycle.**

The forbidden pattern is reaching `electronAPI.on` from a `useEffect`, custom hook, render path, or anywhere else that runs more than once per app lifetime. That is what causes stale closures, double-registration on remount, `MaxListenersExceededWarning`, and state loss on unmount.

A subscription installed exactly once -- at module load or via an install-once guard -- has none of those problems. Such "singleton subscriptions" are allowed in `store/listeners/`, `store/atoms/`, `store/sessionStateListeners.ts`, `services/`, `plugins/`, and `extensions/panels/` (see "Sanctioned singleton subscriptions" below). They are NOT allowed inside component files, even at module scope -- a component file gets imported because someone renders the component, which re-blurs the line between "component-level" and "module-level" subscription. Put singletons in one of the sanctioned directories.

**Unsubscribe with the closure `electronAPI.on(...)` returns. There is no `off(channel, callback)`.**

It was removed in the fix for [#943](https://github.com/nimbalyst/nimbalyst/issues/943). With `contextIsolation: true` Electron hands the preload a *fresh proxy* of the renderer's callback on every crossing, so an `off()` that looks the handler up by callback identity can never find it — every call was a silent no-op. That leaked one `session-files:updated` listener per session switch until a user's renderer crashed after 44 hours of uptime. The returned closure captures the real handler directly, so nothing has to cross the bridge to remove it.

**This is enforced, not advisory.** `store/listeners/__tests__/noComponentIpcSubscriptions.test.ts` fails the pre-push suite if `electronAPI.on(` appears anywhere outside the sanctioned directories, untracked files included. There is deliberately no exemption list — if the guard fires, move the subscription rather than adding your file to it. Before #943 this rule was documentation only, and the violation that crashed a user's renderer sat in the tree for months without anything complaining.

All non-singleton IPC event handling follows this architecture:

1. **Central listeners** subscribe to IPC events ONCE at app startup
2. **Listeners update atoms** when events fire (with debouncing where appropriate)
3. **Components read from atoms** and re-render automatically

## Pattern

```typescript
// BAD: Component subscribing to IPC directly
useEffect(() => {
  const handler = (data) => {
    setLocalState(data);
  };
  const unsubscribe = window.electronAPI.on('some:event', handler);
  return () => unsubscribe();
}, []);

// GOOD: Central listener updates atom, component reads atom
// In store/listeners/someListeners.ts:
export function initSomeListeners(): () => void {
  const handleEvent = (data) => {
    store.set(someAtom, data);
  };
  return window.electronAPI.on('some:event', handleEvent);
}

// In component:
const data = useAtomValue(someAtom);
```

## Benefits

- No race conditions when switching contexts (session, workspace, etc.)
- No stale closures capturing old component state
- No MaxListenersExceededWarning from N components subscribing
- Debouncing in one place instead of every component
- State persists across component unmounts

## Reaction patterns

How components consume the atoms depends on what the listener writes:

- **State atoms** (current value matters): subscribe with `useAtomValue` and render directly. Used by `themeIdAtom`, `sessionFileEditsAtom`, `syncStatusUpdateAtom`, etc.
- **Counter atoms** (fire-and-forget commands): the listener bumps a number; the component captures the initial value in a ref and runs side effects only when the counter changes. Used for menu commands like `file-save`, `navigation:go-back`, `confirm-close-unsaved`.
- **Request atoms** (`{ version, payload } | null`): same idea as counter atoms but the payload travels with the bump. Used for `set-content-mode`, `extension-marketplace:install-request`, `open-navigation-dialog`.
- **Per-key atom families** (per-file, per-session): the listener routes to `atomFamily(key)` so consumers only react to their own key. Used for `file-changed-on-disk` (per file path) and `history:pending-tag-created`.

The "skip the initial mount" idiom for counter/request atoms:

```typescript
const version = useAtomValue(somethingRequestAtom);
const initialRef = useRef(version);
useEffect(() => {
  if (version === initialRef.current) return;
  // ...react to the command
}, [version]);
```

This prevents the side effect from firing on first render with whatever value happened to be in the atom.

## Already Implemented

DO NOT add component-level IPC subscriptions for these events. Use the existing listener or extend it.

### State listeners (atom holds current value)

- **File state** (`store/listeners/fileStateListeners.ts`): `session-files:updated`, `git:status-changed`, `history:pending-count-changed`
- **Session list** (`store/listeners/sessionListListeners.ts`): `sessions:refresh-list`, `sessions:session-updated`, `session-linked-tracker-changed`, `worktree:session-created`
- **Session state** (`store/sessionStateListeners.ts`): `transcript:event`, `ai:message-logged`, `session:title-updated`, `ai:askUserQuestion(+Answered)`, `ai:sessionCancelled`, `ai:exitPlanModeConfirm(+Resolved)`, `ai:toolPermission(+Resolved)`, `ai:gitCommitProposal(+Resolved)`, `notification-clicked`, `sessions:sync-read-state`, `sessions:sync-draft-input`
- **Session transcript** (`store/listeners/sessionTranscriptListeners.ts`): `ai:tokenUsageUpdated`, `ai:error`, `ai:streamResponse`, `ai:promptAdditions`, `ai:queuedPromptsReceived`
- **Super loop** (`store/listeners/superLoopListeners.ts`): `super-loop:event`, `super-loop:iteration-prompt`, `ai:streamResponse`, `ai:error`
- **Claude usage** (`store/listeners/claudeUsageListeners.ts`): `claude-usage:update`
- **Codex usage** (`store/listeners/codexUsageListeners.ts`): `codex-usage:update`
- **File tree** (`store/listeners/fileTreeListeners.ts`): `workspace-file-tree-updated`
- **Voice mode** (`store/listeners/voiceModeListeners.ts`): all `voice-mode:*` events
- **Theme** (`store/listeners/themeListeners.ts`): `theme-change` -> `themeIdAtom`
- **Permissions** (`store/listeners/permissionListeners.ts`): `permissions:changed` -> `permissionsChangedVersionAtom` (counter; consumers re-fetch)
- **Codex auth** (`store/listeners/openAICodexAuthListeners.ts`): `openai-codex:auth-updated` -> `openAICodexAuthVersionAtom` (counter; the settings panel re-fetches)
- **Sync** (`store/listeners/syncListeners.ts`): `sync:status-changed` -> `syncStatusUpdateAtom`
- **Database migration** (`store/listeners/dbMigrationListeners.ts`): `db:migration:phase`/`progress`/`complete`/`failed` -> the `dbMigration*` atoms
- **Update toast** (`store/listeners/updateListeners.ts`): all `update-toast:*` events
- **Tracker sync** (`store/listeners/trackerSyncListeners.ts`): `document-service:tracker-items-changed`, `document-service:metadata-changed`
- **Network availability** (`store/listeners/networkAvailabilityListeners.ts`): `sync:network-available`
- **Tray** (`store/listeners/trayListeners.ts`): `tray:navigate-to-session`, `tray:new-session`, `sync:config-updated`
- **Wakeup** (`store/listeners/wakeupListener.ts`): `wakeup:changed`
- **MCP** (`store/listeners/mcpListeners.ts`): `mcp-config:test-progress` -> `mcpTestProgressAtom`
- **Walkthrough** (`store/listeners/walkthroughListeners.ts`): `trigger-walkthrough`, `reset-walkthroughs`, `trigger-tip`, `reset-tips`
- **Notifications** (`store/listeners/notificationListeners.ts`): `notifications:check-active-session` (responds via send, no atom needed)
- **AI command** (`store/listeners/aiCommandListeners.ts`): `ai:promptClaimed` (re-dispatched as DOM CustomEvent)
- **Terminals** (`store/atoms/terminals.ts`, module-level init): `terminal:list-changed`

### Command listeners (counter or request atoms)

- **App commands** (`store/listeners/appCommandListeners.ts`): menu/main-process commands -- `file-new-mockup`, `toggle-ai-chat-panel`, `file-save`, `show-unified-onboarding`, `show-windows-claude-code-warning`, `open-navigation-dialog`, `navigation:go-back`/`go-forward`, `extension-marketplace:install-request`, `set-content-mode`, `agent:insert-plan-reference`, `show-project-selection-dialog`, `show-discord-invitation`, `show-trust-toast`, `show-session-import-dialog`, `show-extension-project-intro-dialog`, `show-figma-mcp-migration`, `confirm-close-unsaved`, `close-active-tab`, `reopen-last-closed-tab`
- **Menu commands** (`store/listeners/menuCommandListeners.ts`): `menu:find`, `menu:find-next`, `menu:find-previous` -> counter atoms; `useIPCHandlers` reacts and routes per active mode
- **Sound commands** (`store/listeners/soundListeners.ts`): `play-completion-sound`, `play-permission-sound` (plays sound directly; no atom)

### Per-key atom families

- **File watch** (`store/listeners/fileChangeListeners.ts`): `file-changed-on-disk` -> `fileChangedOnDiskAtomFamily(path)`, `history:pending-tag-created` -> `historyPendingTagCreatedAtomFamily(path)`. Backing stores like `DiskBackedStore` subscribe via `store.sub` with their own file path.

## When Adding New IPC Events

1. Create or extend a centralized listener file in `store/listeners/`
2. Initialize it in `App.tsx` alongside the other `init*Listeners()` calls (one shared `useEffect` registers them all)
3. Update atoms from the listener, never from components
4. Add debouncing if events can fire rapidly (e.g., file system watchers, sync events)
5. Decide which atom shape fits the use case (state vs counter vs request vs per-key family) -- see "Reaction patterns" above

## File Structure

```
packages/electron/src/renderer/store/
  listeners/
    aiCommandListeners.ts
    appCommandListeners.ts
    claudeUsageListeners.ts
    codexUsageListeners.ts
    dbMigrationListeners.ts
    fileChangeListeners.ts
    fileStateListeners.ts
    fileTreeListeners.ts
    mcpListeners.ts
    menuCommandListeners.ts
    networkAvailabilityListeners.ts
    notificationListeners.ts
    openAICodexAuthListeners.ts
    permissionListeners.ts
    sessionListListeners.ts
    sessionTranscriptListeners.ts
    soundListeners.ts
    superLoopListeners.ts
    syncListeners.ts
    themeListeners.ts
    trackerSyncListeners.ts
    trayListeners.ts
    updateListeners.ts
    voiceModeListeners.ts
    wakeupListener.ts
    walkthroughListeners.ts
  atoms/
    (state atoms updated by listeners)
  sessionStateListeners.ts
```

## Sanctioned singleton subscriptions

These call `electronAPI.on(...)` outside `store/listeners/` and are fine because they install exactly once and never react to React lifecycle:

- `plugins/registerExtensionSystem.ts` -- request/response RPC handlers (`screenshot:capture`, `editor:capture-screenshot`, `extension:get-status`, `renderer:eval`, `extension-test:open-file`, `extension-test:ai-tool`); registered at module load
- `services/RendererDocumentService.ts` -- singleton document service; registers its three `document-service:*` listeners in its constructor
- `extensions/panels/PanelHostImpl.ts` -- generic event pass-through exposed to extensions; the channel is supplied by the extension at runtime, so it cannot be enumerated up front
- `store/atoms/terminals.ts` -- module-level init that runs once for `terminal:list-changed`
- `store/atoms/appSettings.ts` -- `debug-flags:changed` registered once via an `installed` flag inside `initDebugFlags()`
- `services/projectFileSystemHost.ts` -- `EditorHost.fs.onChanged`, a per-editor subscription the calling editor disposes; it lives in `services/` rather than `TabEditor.tsx` precisely because it touches IPC

When you add another singleton subscription, put it in one of these directories (`store/listeners/`, `store/atoms/`, `store/sessionStateListeners.ts`, `services/`, `plugins/`, `extensions/panels/`) and either run it at module top level or guard it with an install-once flag. Do **not** put a "module-level" subscription inside a component file -- the component file gets re-imported in test contexts, HMR, and lazy-loaded routes, and the subscription leaks through.

## Anti-Patterns

| Anti-Pattern | Problem | Solution |
| --- | --- | --- |
| `useEffect` with `electronAPI.on()` in a component | Race conditions, stale closures | Use centralized listener |
| Multiple components subscribing to same event | MaxListenersExceededWarning | Single listener updates atom |
| Component-local state from IPC | State lost on unmount | Store in atom |
| No debouncing on rapid events | Performance issues | Debounce in listener |
| Reacting to a counter/request atom without skipping the initial mount value | Side effect runs on every refresh, not just on the IPC event | Capture the initial value in a ref and bail out when it matches |
| Module-level `electronAPI.on()` inside a component file (even outside any hook) | Component files get re-imported (HMR, lazy routes, tests) and the subscription quietly multiplies | Move the singleton into `store/listeners/`, `store/atoms/`, or one of the other sanctioned directories above |
| Unsubscribing by passing the callback back (`off(channel, callback)`) | contextBridge re-proxies the callback on every crossing, so identity-based removal never matches and the listener leaks | Call the closure `on()` returns |
