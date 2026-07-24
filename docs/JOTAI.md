# Jotai State Architecture

This document outlines Nimbalyst's patterns for using Jotai atoms, with a focus on avoiding common pitfalls like state divergence and race conditions.

## Core Principle: Single Source of Truth

**Every piece of state should have exactly ONE authoritative source.** Derived values should be computed from that source, not stored separately.

## State & Persistence Overview

Nimbalyst has two persistent storage backends, each with different characteristics:

| Storage | Location | Use Case | Access Pattern |
|---------|----------|----------|----------------|
| **PGLite Database** | `~/Library/Application Support/@nimbalyst/electron/pglite-db` | Session data, messages, file edits | IPC → Repository → DB |
| **Workspace State (JSON)** | `.nimbalyst/workspace-state.json` in each project | UI layout, panel sizes, editor tabs | IPC → electron-store |
| **App Settings (JSON)** | `~/Library/Application Support/@nimbalyst/electron/config.json` | Global settings, API keys | IPC → electron-store |

### The Full Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              RENDERER PROCESS                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  React Components                                                           │
│       │                                                                     │
│       │ useAtomValue() / useSetAtom()                                       │
│       ▼                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         JOTAI ATOMS                                  │   │
│  │                                                                      │   │
│  │  Store Atoms ◄──────── Derived Atoms                                │   │
│  │  (source of truth)     (computed views)                             │   │
│  │       │                                                              │   │
│  │       │ Action atoms trigger IPC                                    │   │
│  └───────┼──────────────────────────────────────────────────────────────┘   │
│          │                         ▲                                        │
│          │                         │                                        │
│          ▼                         │ Central IPC Listeners                  │
│  ┌─────────────────────────────────┴────────────────────────────────────┐   │
│  │                    window.electronAPI                                │   │
│  │                    (IPC Bridge)                                      │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │ IPC
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                               MAIN PROCESS                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────────┐  │
│  │  IPC Handlers    │    │  Services        │    │  File Watchers       │  │
│  │  (SessionHandlers│    │  (AIService,     │    │  (workspace changes) │  │
│  │   SettingsHandlers)   │   SyncService)   │    │                      │  │
│  └────────┬─────────┘    └────────┬─────────┘    └──────────┬───────────┘  │
│           │                       │                          │              │
│           ▼                       ▼                          ▼              │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                         REPOSITORIES                                 │  │
│  │  AISessionsRepository, WorkspaceStateRepository, etc.               │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│           │                                           │                     │
│           ▼                                           ▼                     │
│  ┌─────────────────────┐                    ┌─────────────────────────┐    │
│  │  PGLite Database    │                    │  electron-store (JSON)  │    │
│  │  (sessions, messages)                    │  (settings, workspace)  │    │
│  └─────────────────────┘                    └─────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Data Flow Patterns by State Type

#### 1. Session Data (Database-backed)

```
User action (submit message)
    │
    ▼
Component calls action atom (e.g., submitMessageAtom)
    │
    ▼
Action atom calls IPC: window.electronAPI.invoke('ai:sendMessage', ...)
    │
    ▼
Main process: AIService processes, stores in PGLite via AISessionsRepository
    │
    ▼
Main process: Sends IPC event 'ai:message-logged'
    │
    ▼
Renderer: Central listener (sessionStateListeners.ts) receives event
    │
    ▼
Listener calls: store.set(reloadSessionDataAtom, { sessionId })
    │
    ▼
reloadSessionDataAtom fetches fresh data via IPC, updates sessionStoreAtom
    │
    ▼
Derived atoms (sessionMessagesAtom, etc.) automatically reflect new data
    │
    ▼
React components re-render with new values
```

**Key Points:**
- Database is the ultimate source of truth
- `sessionStoreAtom` is the in-memory cache
- IPC events trigger reloads to sync cache with DB
- Derived atoms prevent divergence

#### 2. Workspace State (JSON file-backed)

```
User action (resize panel)
    │
    ▼
Component calls: set(workspaceStateAtom, newState)
    │                    OR
Component uses: useWorkspaceState() hook with setter
    │
    ▼
Setter atom debounces and calls IPC:
    window.electronAPI.invoke('workspace:update-state', path, updates)
    │
    ▼
Main process: Deep merges updates into workspace-state.json
    │
    ▼
(No IPC event back - workspace state is write-and-forget for UI state)
```

**Key Points:**
- JSON file is the ultimate source of truth (persists across sessions)
- Atom is initialized from JSON on app start
- Updates are debounced to avoid excessive file writes
- Deep merge allows partial updates without losing other fields

#### 3. App Settings (Global JSON)

```
User changes setting in SettingsView
    │
    ▼
Component calls: set(setAgentModeSettingsAtom, { defaultModel: 'opus' })
    │
    ▼
Setter atom updates local atom AND schedules debounced IPC:
    window.electronAPI.invoke('settings:set-default-ai-model', model)
    │
    ▼
Main process: Updates electron-store (config.json)
    │
    ▼
(No IPC event back - settings are write-and-forget)
```

**Key Points:**
- Each settings domain has its own atom + init function
- Init functions load from IPC on app startup
- Setter atoms handle both local update and persistence
- Debouncing prevents excessive IPC during rapid changes

## Initialization Sequence

On app startup, state must be loaded from persistent storage before UI renders:

```typescript
// In renderer/index.tsx
async function initializeApp() {
  // 1. Initialize all settings atoms from IPC (parallel)
  await Promise.all([
    initVoiceModeSettings().then(s => store.set(voiceModeSettingsAtom, s)),
    initAgentModeSettings().then(s => store.set(agentModeSettingsAtom, s)),
    initNotificationSettings().then(s => store.set(notificationSettingsAtom, s)),
    // ... other settings
  ]);

  // 2. Render app (settings atoms now have correct values)
  root.render(<App />);

  // 3. Session list loads lazily when AgentMode mounts
  // 4. Individual sessions load when their tabs are opened
}
```

**Critical:** Settings must be initialized BEFORE rendering to avoid showing default values that flash to real values.

## Session State Architecture

Session state follows a hierarchical model where `sessionStoreAtom` is the single source of truth for all session data:

```
sessionStoreAtom(sessionId)          <- Single source of truth (SessionData)
    ├── sessionModeAtom(sessionId)   <- Derived read-write atom
    ├── sessionModelAtom(sessionId)  <- Derived read-write atom
    ├── sessionTitleAtom(sessionId)  <- Derived read-only atom
    ├── sessionMessagesAtom(sessionId) <- Derived read-only atom
    └── ... other derived atoms
```

### Why Derived Atoms?

**The Problem with Independent Atoms:**

```typescript
// BAD: Independent atom that can diverge from sessionStoreAtom
export const sessionModeAtom = atomFamily((_sessionId: string) =>
  atom<AIMode>('agent')  // Stores its own value
);
```

This pattern causes bugs:
1. `reloadSessionDataAtom` updates `sessionStoreAtom` with fresh data from DB
2. `sessionModeAtom` still has its old value
3. UI reads `sessionModeAtom` and shows stale/wrong mode
4. User sees session randomly switch modes

**The Solution: Derived Read-Write Atoms:**

```typescript
// GOOD: Derived atom that reads from and writes through sessionStoreAtom
export const sessionModeAtom = atomFamily((sessionId: string) =>
  atom(
    // Read: derive from sessionStoreAtom
    (get) => get(sessionStoreAtom(sessionId))?.mode || 'agent',
    // Write: update sessionStoreAtom
    (get, set, newMode: AIMode) => {
      const current = get(sessionStoreAtom(sessionId));
      if (current) {
        set(sessionStoreAtom(sessionId), { ...current, mode: newMode });
      }
    }
  )
);
```

Benefits:
- When `sessionStoreAtom` is updated, all derived atoms automatically reflect the new values
- Writes go through `sessionStoreAtom`, maintaining consistency
- No manual sync code needed

### Pattern: Initializing Session Store for New Sessions

When creating sessions before the full data is loaded from DB, initialize `sessionStoreAtom` with minimal data so derived atoms work:

```typescript
// When adding a new session (optimistic update)
set(sessionStoreAtom(session.id), {
  id: session.id,
  title: session.title || 'New Session',
  provider: session.provider || 'claude-code',
  model: session.model || 'claude-code:sonnet',
  mode: 'agent',
  messages: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
} as SessionData);
```

This ensures:
- `sessionModeAtom(id)` returns 'agent' instead of undefined
- `sessionModelAtom(id)` returns the correct model instead of the hardcoded default
- UI shows correct values immediately, before `loadSessionDataAtom` runs

## Atom Categories

### 1. Store Atoms (Source of Truth)

These hold the authoritative data:

```typescript
// Full session data - THE source of truth
export const sessionStoreAtom = atomFamily((_sessionId: string) =>
  atom<SessionData | null>(null)
);

// Registry of all sessions (metadata only, for sidebar)
export const sessionRegistryAtom = atom<Map<string, SessionMeta>>(new Map());
```

### 2. Derived Read-Only Atoms

For components that only need a slice of data (prevents re-renders on unrelated changes):

```typescript
// Only re-renders when title changes, not when messages change
export const sessionTitleAtom = atomFamily((sessionId: string) =>
  atom((get) => {
    const data = get(sessionStoreAtom(sessionId));
    return data?.title || 'Untitled';
  })
);

// Only re-renders when messages change
export const sessionMessagesAtom = atomFamily((sessionId: string) =>
  atom((get) => get(sessionStoreAtom(sessionId))?.messages || [])
);
```

### 3. Derived Read-Write Atoms

For values that can be both read and updated:

```typescript
export const sessionModeAtom = atomFamily((sessionId: string) =>
  atom(
    (get) => get(sessionStoreAtom(sessionId))?.mode || 'agent',
    (get, set, newMode: AIMode) => {
      const current = get(sessionStoreAtom(sessionId));
      if (current) {
        set(sessionStoreAtom(sessionId), { ...current, mode: newMode });
      }
    }
  )
);
```

### 4. UI-Only Atoms

For transient UI state that doesn't need persistence:

```typescript
// Processing indicator
export const sessionProcessingAtom = atomFamily((_sessionId: string) =>
  atom<boolean>(false)
);

// Temporary input for history navigation
export const sessionTempInputAtom = atomFamily((_sessionId: string) =>
  atom<string>('')
);
```

**Note:** `sessionDraftInputAtom` is NOT UI-only - it is persisted to the database via
debounced IPC calls to survive app restarts. It's loaded from `sessionData.draftInput`
in `loadSessionDataAtom` and saved via `ai:saveDraftInput` with 1-second debounce.

### 5. Action Atoms

For complex operations that update multiple atoms:

```typescript
export const updateSessionStoreAtom = atom(
  null,
  (get, set, update: { sessionId: string; updates: Partial<SessionData> }) => {
    const { sessionId, updates } = update;

    // Update store atom
    const current = get(sessionStoreAtom(sessionId));
    if (current) {
      set(sessionStoreAtom(sessionId), { ...current, ...updates });
    }

    // Update registry for sidebar
    const registry = new Map(get(sessionRegistryAtom));
    const meta = registry.get(sessionId);
    if (meta) {
      registry.set(sessionId, { ...meta, ...updates });
      set(sessionRegistryAtom, registry);
    }
  }
);
```

## Integration with Centralized IPC Listeners

See [centralized-ipc-listener-architecture.md](../plans/centralized-ipc-listener-architecture.md) for the full pattern.

### The Flow

```
Main Process (IPC Event)
        │
        ▼
Centralized Listener (store/listeners/*.ts)
        │
        ▼
store.set(atom, value)  <- Updates source of truth
        │
        ▼
Derived Atoms           <- Automatically updated
        │
        ▼
React Components        <- Re-render with new values
```

### Example: Session Reload

```typescript
// In store/listeners/sessionStateListeners.ts
window.electronAPI.on('ai:message-logged', (data) => {
  // This updates sessionStoreAtom, which automatically updates:
  // - sessionModeAtom (derived)
  // - sessionModelAtom (derived)
  // - sessionMessagesAtom (derived)
  // - sessionTitleAtom (derived)
  store.set(reloadSessionDataAtom, { sessionId: data.sessionId });
});
```

### Why This Works

1. **Single update point**: `reloadSessionDataAtom` updates `sessionStoreAtom`
2. **Automatic propagation**: All derived atoms read from `sessionStoreAtom`
3. **No manual sync**: No need to remember to update N atoms when data changes
4. **No race conditions**: Derived atoms always reflect current store state

## Common Anti-Patterns

### Anti-Pattern 1: Independent Atoms for Derived Data

```typescript
// BAD: Two atoms that can diverge
export const sessionStoreAtom = atomFamily(...);  // Has mode field
export const sessionModeAtom = atomFamily(() => atom('agent'));  // Separate storage

// When sessionStoreAtom is updated, sessionModeAtom still has old value!
```

**Fix:** Make `sessionModeAtom` a derived atom that reads from `sessionStoreAtom`.

### Anti-Pattern 2: Manual Sync Code

```typescript
// BAD: Manually syncing atoms after every update
set(sessionStoreAtom(sessionId), sessionData);
set(sessionModeAtom(sessionId), sessionData.mode);  // Easy to forget!
set(sessionModelAtom(sessionId), sessionData.model);  // Easy to forget!
```

**Fix:** Use derived atoms so updates propagate automatically.

### Anti-Pattern 3: Component-Level IPC Subscriptions

```typescript
// BAD: Component subscribes to IPC and updates local state
useEffect(() => {
  const cleanup = window.electronAPI.on('ai:modeChanged', (data) => {
    if (data.sessionId === sessionId) {
      setMode(data.mode);  // Local state can diverge from atoms
    }
  });
  return cleanup;
}, [sessionId]);
```

**Fix:** Central listener updates atoms, component reads from atoms.

### Anti-Pattern 4: Not Initializing Store for New Sessions

```typescript
// BAD: Only adding to registry, derived atoms return defaults
set(sessionRegistryAtom, registry);  // sessionStoreAtom is still null!
// sessionModeAtom(id) returns 'agent' (default)
// sessionModelAtom(id) returns 'claude-code:sonnet' (default, wrong!)
```

**Fix:** Initialize `sessionStoreAtom` with minimal data when creating sessions.

## Checklist for New Session-Related Atoms

When adding a new piece of session state:

1. **Is it derived from existing data?**
   - YES → Create a derived atom that reads from `sessionStoreAtom`
   - NO → Consider if it should be added to `SessionData` type

2. **Does it need to be writable?**
   - YES → Create a read-write derived atom
   - NO → Create a read-only derived atom

3. **Is it persisted to DB?**
   - YES → Ensure `sessionStoreAtom` is the source of truth, update propagates to DB
   - NO → Can be a UI-only atom (e.g., `sessionTempInputAtom`, `sessionProcessingAtom`)

4. **Is it updated by IPC events?**
   - YES → Central listener updates `sessionStoreAtom`, derived atoms auto-update
   - NO → Action atoms or component callbacks update via `sessionStoreAtom`

## Testing Derived Atoms

```typescript
import { createStore } from 'jotai';

describe('sessionModeAtom', () => {
  it('derives from sessionStoreAtom', () => {
    const store = createStore();
    const sessionId = 'test-session';

    // Initially null, returns default
    expect(store.get(sessionModeAtom(sessionId))).toBe('agent');

    // Set store data
    store.set(sessionStoreAtom(sessionId), {
      id: sessionId,
      mode: 'planning',
      // ... other fields
    });

    // Derived atom reflects new value
    expect(store.get(sessionModeAtom(sessionId))).toBe('planning');
  });

  it('writes through sessionStoreAtom', () => {
    const store = createStore();
    const sessionId = 'test-session';

    // Initialize store
    store.set(sessionStoreAtom(sessionId), {
      id: sessionId,
      mode: 'agent',
    });

    // Write via derived atom
    store.set(sessionModeAtom(sessionId), 'planning');

    // Store is updated
    expect(store.get(sessionStoreAtom(sessionId))?.mode).toBe('planning');
  });
});
```

## Summary

| Pattern | When to Use | Example |
|---------|-------------|---------|
| Store Atom | Authoritative data storage | `sessionStoreAtom` |
| Derived Read-Only | Component needs slice of data | `sessionTitleAtom` |
| Derived Read-Write | Value can be read and updated | `sessionModeAtom`, `sessionArchivedAtom` |
| UI-Only Atom | Transient state, not persisted | `sessionProcessingAtom`, `sessionTempInputAtom` |
| Debounced-Persist Atom | UI state that should survive restarts | `sessionDraftInputAtom` |
| Action Atom | Complex multi-atom updates | `updateSessionStoreAtom` |

**Golden Rule:** If you're writing code to "sync" two atoms, you probably have an architecture problem. Use derived atoms instead.

## Persistence Patterns

### When to Use Each Storage Backend

| Data Type | Storage | Why |
|-----------|---------|-----|
| Session messages | PGLite | Relational queries, large data, full-text search |
| Session metadata (mode, model) | PGLite | Part of session record |
| File edit tracking | PGLite | Needs relational queries with sessions |
| Panel sizes, layout | Workspace JSON | Per-project UI state, simple key-value |
| Open editor tabs | Workspace JSON | Per-project, restored on workspace open |
| API keys | App Settings JSON | Global, sensitive (encrypted at rest) |
| Default model preference | App Settings JSON | Global user preference |
| Draft input text | Atom only (no persistence) | Transient, lost on refresh is OK |

### Pattern: Persisted Atom with Debounced Write

For settings that need to persist but change frequently (e.g., panel resize):

```typescript
// 1. Main atom holds current state
export const panelWidthAtom = atom<number>(300);

// 2. Debounce timer (module-level)
let persistTimer: ReturnType<typeof setTimeout> | null = null;

// 3. Setter atom that updates local state AND schedules persist
export const setPanelWidthAtom = atom(
  null,
  (get, set, width: number) => {
    // Immediate local update (UI responsive)
    set(panelWidthAtom, width);

    // Debounced persist (avoid excessive IPC/file writes)
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      window.electronAPI.invoke('workspace:update-state', workspacePath, {
        panelWidth: width
      });
    }, 500);
  }
);
```

### Pattern: Atom Initialized from Persistent Storage

For state that must be loaded before use:

```typescript
// 1. Atom with safe default
export const agentModeSettingsAtom = atom<AgentModeSettings>({
  defaultModel: 'claude-code:opus',  // Default if init fails
});

// 2. Init function called at app startup
export async function initAgentModeSettings(): Promise<AgentModeSettings> {
  try {
    const model = await window.electronAPI.invoke('settings:get-default-ai-model');
    return { defaultModel: model || 'claude-code:opus' };
  } catch (error) {
    console.error('Failed to load settings:', error);
    return { defaultModel: 'claude-code:opus' };
  }
}

// 3. In app initialization (before render)
const settings = await initAgentModeSettings();
store.set(agentModeSettingsAtom, settings);
```

### Pattern: Two-Way Sync with Database

For session data that's both read and written:

```typescript
// Reading: Atom populated from DB via IPC
export const loadSessionDataAtom = atom(
  null,
  async (get, set, sessionId: string) => {
    const data = await window.electronAPI.invoke('sessions:load', sessionId);
    set(sessionStoreAtom(sessionId), data);
  }
);

// Writing: Changes go to DB, then refresh atom
export const updateSessionModeAtom = atom(
  null,
  async (get, set, { sessionId, mode }: { sessionId: string; mode: AIMode }) => {
    // 1. Optimistic update (immediate UI feedback)
    const current = get(sessionStoreAtom(sessionId));
    if (current) {
      set(sessionStoreAtom(sessionId), { ...current, mode });
    }

    // 2. Persist to database
    await window.electronAPI.invoke('sessions:update-mode', sessionId, mode);

    // Note: No need to reload - optimistic update is sufficient
    // If DB write fails, we'd need error handling to rollback
  }
);
```

### Anti-Pattern: Reading from Persistence on Every Render

```typescript
// BAD: Fetches from IPC on every component mount
function SessionPanel({ sessionId }) {
  const [mode, setMode] = useState('agent');

  useEffect(() => {
    // This causes waterfall loading and flickering
    window.electronAPI.invoke('sessions:get-mode', sessionId)
      .then(setMode);
  }, [sessionId]);
}
```

**Fix:** Load into atoms once, components read from atoms:

```typescript
// GOOD: Atom is source of truth, loaded once
function SessionPanel({ sessionId }) {
  const mode = useAtomValue(sessionModeAtom(sessionId));
  // No loading state needed - atom already has data (or default)
}
```

## Handling Stale Persisted Data

When adding new fields to persisted state, old data files won't have them:

```typescript
// ALWAYS merge with defaults when loading persisted state
export async function initAgentModeSettings(): Promise<AgentModeSettings> {
  const defaults: AgentModeSettings = {
    defaultModel: 'claude-code:opus',
    newField: 'default',  // Added in v2.0
  };

  try {
    const loaded = await window.electronAPI.invoke('settings:get-agent-mode');
    return {
      ...defaults,           // Start with all defaults
      ...loaded,             // Override with persisted values
    };
  } catch {
    return defaults;
  }
}
```

See also: "State Persistence Migration Safety" in CLAUDE.md for the full pattern.
